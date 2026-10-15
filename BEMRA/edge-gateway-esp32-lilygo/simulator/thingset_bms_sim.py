#!/usr/bin/env python3
"""
Libre Solar BMS C1 ThingSet serial simulator (bench stand-in for the real BMS).

Emits exactly what the BMS firmware prints on its ThingSet UART
(LibreSolar/bms-firmware + ThingSet/thingset-zephyr-sdk, text mode):

    #mLive {"Meas":{"rPackVoltage_V":13.24,...,"rCellVoltages_V":[...16 values...]}}\r\n

  * one live report on start, then every --interval seconds (default 30 s,
    matching PUBLISH_INTERVAL_MS in the gateway config.h)
  * field set identical to the BEMRA contract test payload (8 Meas values,
    one voltage per connected cell, one temperature per thermistor).
    The gateway adds the envelope (ids, boot_id, sequence) and publishes.
  * answers ThingSet requests "?Device" and "?Conf" with ":85 {...}"
  * optional CRC suffix " XXXXXXXX#" (CONFIG_THINGSET_SERIAL_USE_CRC)

Battery model: LiFePO4 cells using the firmware's own OCV table, coulomb
counting, per-cell internal resistance and capacity spread (natural imbalance),
I^2R heating, and the firmware's default protection limits.

Lines received from the gateway that are not ThingSet requests are printed as
gateway logs, so in USB mode one window shows both sides.

Usage
  python thingset_bms_sim.py --port COM5                 # stream to the ESP32
  python thingset_bms_sim.py --dry-run                   # print to console only
  python thingset_bms_sim.py --port COM5 --scenario charge --cells 4
  python thingset_bms_sim.py --port COM5 --fault undervoltage --fault-at 60
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import threading
import time
import zlib

# --- Firmware constants (LibreSolar/bms-firmware, app/src/bms_common.c) ------
MAX_CELLS = 16          # CONFIG_BMS_IC_MAX_CELLS (bq769x2)
MAX_THERMISTORS = 3     # CONFIG_BMS_IC_MAX_THERMISTORS
OCV_LFP = [3.392, 3.314, 3.309, 3.308, 3.304, 3.296, 3.283, 3.275, 3.271, 3.268, 3.265,
           3.264, 3.262, 3.252, 3.240, 3.226, 3.213, 3.190, 3.177, 3.132, 2.833]
SOC_POINTS = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0]
LFP_LIMITS = dict(cell_ov=3.80, cell_ov_reset=3.40, cell_uv=2.50, cell_uv_reset=3.10,
                  dis_ot=45.0, chg_ot=45.0, chg_ut=0.0, dis_ut=-20.0, hyst=5.0)

# enum bms_state (include/bms/bms.h)
BMS_STATE_OFF, BMS_STATE_CHG, BMS_STATE_DIS, BMS_STATE_NORMAL, BMS_STATE_SHUTDOWN = range(5)
# BMS_ERR_* bits (include/bms/bms_common.h)
ERR_CELL_UNDERVOLTAGE, ERR_CELL_OVERVOLTAGE = 1 << 0, 1 << 1
ERR_DIS_OVERCURRENT, ERR_CHG_OVERCURRENT = 1 << 3, 1 << 4
ERR_DIS_OVERTEMP, ERR_CHG_UNDERTEMP, ERR_CHG_OVERTEMP = 1 << 7, 1 << 8, 1 << 9


def ocv_lfp(soc: float) -> float:
    """Open-circuit voltage from SOC by linear interpolation of the firmware table."""
    soc = max(0.0, min(100.0, soc))
    for i in range(len(SOC_POINTS) - 1):
        hi, lo = SOC_POINTS[i], SOC_POINTS[i + 1]
        if lo <= soc <= hi:
            f = (soc - lo) / (hi - lo)
            return OCV_LFP[i + 1] + f * (OCV_LFP[i] - OCV_LFP[i + 1])
    return OCV_LFP[-1]


class Battery:
    """Series string of LFP cells with coulomb counting and simple thermal model."""

    def __init__(self, cells: int, capacity_ah: float, soc: float, seed: int):
        rnd = random.Random(seed)
        self.n = cells
        self.capacity_ah = capacity_ah
        # Manufacturing spread: capacity ±2 %, resistance 15–25 mΩ, SOC offset ±1 %
        self.cap = [capacity_ah * rnd.uniform(0.98, 1.02) for _ in range(cells)]
        self.r_int = [rnd.uniform(0.015, 0.025) for _ in range(cells)]
        self.cell_soc = [max(0.0, min(100.0, soc + rnd.uniform(-1.0, 1.0))) for _ in range(cells)]
        self.temps = [25.0, 25.3]
        self.ic_temp = 28.0
        self.mosfet_temp = 26.0
        self.shunt_temp = 26.0
        self.current = 0.0
        self.error_flags = 0
        self.state = BMS_STATE_NORMAL
        self.chg_enable = True
        self.dis_enable = True
        self.forced_fault = 0

    @property
    def soc(self) -> float:
        # Pack SOC is limited by the weakest cell (what a BMS reports)
        return min(self.cell_soc)

    def cell_voltages(self) -> list[float]:
        return [ocv_lfp(s) + self.current * r for s, r in zip(self.cell_soc, self.r_int)]

    def step(self, requested_a: float, dt: float, ambient: float) -> None:
        # Protection: FETs off -> no current in that direction (like the real BMS)
        i = requested_a
        if i > 0 and not self.chg_enable:
            i = 0.0
        if i < 0 and not self.dis_enable:
            i = 0.0
        self.current = i
        for k in range(self.n):
            self.cell_soc[k] += (i * dt / 3600.0) / self.cap[k] * 100.0
            self.cell_soc[k] = max(0.0, min(100.0, self.cell_soc[k]))
        # First-order thermal model: I^2R heating towards ambient
        heat = i * i * sum(self.r_int)
        tau = 300.0
        for t in range(len(self.temps)):
            target = ambient + heat * (3.0 + t)
            self.temps[t] += (target - self.temps[t]) * min(1.0, dt / tau)
        self.mosfet_temp += (ambient + 2.0 + heat * 8.0 - self.mosfet_temp) * min(1.0, dt / 120.0)
        self.shunt_temp += (ambient + 1.0 + heat * 6.0 - self.shunt_temp) * min(1.0, dt / 120.0)
        self.ic_temp += (ambient + 4.0 - self.ic_temp) * min(1.0, dt / 600.0)
        self._protect()

    def _protect(self) -> None:
        v = self.cell_voltages()
        lim = LFP_LIMITS
        flags = self.error_flags
        if min(v) < lim["cell_uv"]:
            flags |= ERR_CELL_UNDERVOLTAGE
        elif min(v) > lim["cell_uv_reset"]:
            flags &= ~ERR_CELL_UNDERVOLTAGE
        if max(v) > lim["cell_ov"]:
            flags |= ERR_CELL_OVERVOLTAGE
        elif max(v) < lim["cell_ov_reset"]:
            flags &= ~ERR_CELL_OVERVOLTAGE
        t_max = max(self.temps)
        if t_max > lim["dis_ot"]:
            flags |= ERR_DIS_OVERTEMP
        elif t_max < lim["dis_ot"] - lim["hyst"]:
            flags &= ~ERR_DIS_OVERTEMP
        if self.current < -self.capacity_ah:   # dis_oc_limit = nominal capacity (firmware default)
            flags |= ERR_DIS_OVERCURRENT
        if self.current > self.capacity_ah:
            flags |= ERR_CHG_OVERCURRENT
        flags |= self.forced_fault
        self.error_flags = flags
        chg_block = ERR_CELL_OVERVOLTAGE | ERR_CHG_OVERCURRENT | ERR_CHG_OVERTEMP | ERR_CHG_UNDERTEMP
        dis_block = ERR_CELL_UNDERVOLTAGE | ERR_DIS_OVERCURRENT | ERR_DIS_OVERTEMP
        self.chg_enable = not (flags & chg_block)
        self.dis_enable = not (flags & dis_block)
        self.state = {(True, True): BMS_STATE_NORMAL, (True, False): BMS_STATE_CHG,
                      (False, True): BMS_STATE_DIS, (False, False): BMS_STATE_OFF}[(self.chg_enable, self.dis_enable)]

    def meas(self) -> dict:
        """ThingSet Meas values: exactly the field set of the BEMRA contract test
        payload (same names, units and decimals as the Libre Solar firmware)."""
        v = self.cell_voltages()
        return {
            "rPackVoltage_V": round(sum(v), 2),
            "rPackCurrent_A": round(self.current, 2),
            "rSOC_pct": round(self.soc, 1),
            "rCellVoltages_V": [round(x, 3) for x in v],
            "rCellTemps_degC": [round(t, 1) for t in self.temps],
            "rICTemp_degC": round(self.ic_temp, 1),
            "rErrorFlags": self.error_flags,
            "rBmsState": self.state,
        }


def profile_current(scenario: str, t: float, fixed: float | None, capacity: float) -> float:
    """Requested pack current (A, + = charging) for a scenario at time t (s)."""
    if fixed is not None:
        return fixed
    if scenario == "charge":
        return 0.5 * capacity
    if scenario == "discharge":
        return -0.4 * capacity
    if scenario == "idle":
        return 0.0
    # "cycle": compressed solar day, 10-minute period:
    # 4 min charging (solar), 1 min rest, 4 min discharging (evening load), 1 min rest
    phase = t % 600
    noise = 0.05 * math.sin(t / 7.0)
    if phase < 240:
        return round(0.5 * capacity * math.sin(math.pi * phase / 240) + noise, 2)
    if phase < 300:
        return 0.0
    if phase < 540:
        return round(-0.35 * capacity + noise, 2)
    return 0.0


def thingset_line(body: str, crc: bool) -> bytes:
    line = body
    if crc:  # CONFIG_THINGSET_SERIAL_USE_CRC: " %08X#" over the message (crc32 IEEE)
        line += " %08X#" % (zlib.crc32(body.encode()) & 0xFFFFFFFF)
    return (line + "\r\n").encode()


def main() -> int:
    ap = argparse.ArgumentParser(description="Libre Solar BMS ThingSet serial simulator")
    ap.add_argument("--port", help="serial port of the ESP32 (e.g. COM5) or of a USB-TTL adapter")
    ap.add_argument("--baud", type=int, default=115200, help="ThingSet serial baud rate (default 115200)")
    ap.add_argument("--dry-run", action="store_true", help="print reports to the console, no serial port")
    ap.add_argument("--interval", type=float, default=30.0, help="report period in s (default 30 = one report per gateway publish)")
    ap.add_argument("--cells", type=int, default=4, choices=range(3, MAX_CELLS + 1), metavar="3-16")
    ap.add_argument("--capacity", type=float, default=6.0, help="nominal capacity in Ah (default 6)")
    ap.add_argument("--soc", type=float, default=70.0, help="initial SOC in %% (default 70)")
    ap.add_argument("--scenario", choices=["cycle", "charge", "discharge", "idle"], default="cycle")
    ap.add_argument("--current", type=float, help="fixed pack current in A (+ charging), overrides scenario")
    ap.add_argument("--ambient", type=float, default=25.0, help="ambient temperature in degC")
    ap.add_argument("--speed", type=float, default=1.0, help="simulation time multiplier (e.g. 60 = 1 min per s)")
    ap.add_argument("--fault", choices=["undervoltage", "overvoltage", "overtemp"], help="inject a protection fault")
    ap.add_argument("--fault-at", type=float, default=60.0, help="seconds after start to inject --fault")
    ap.add_argument("--fault-for", type=float, default=60.0, help="fault duration in seconds")
    ap.add_argument("--crc", action="store_true", help="append ThingSet CRC suffix")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if not args.dry_run and not args.port:
        ap.error("--port is required unless --dry-run is used")

    bat = Battery(args.cells, args.capacity, args.soc, args.seed)
    ser = None
    if not args.dry_run:
        import serial  # pyserial

        ser = serial.Serial()
        ser.port, ser.baudrate, ser.timeout = args.port, args.baud, 0.1
        ser.dtr = False   # do not hold the ESP32 in reset via the auto-reset circuit
        ser.rts = False
        ser.open()

    write_lock = threading.Lock()

    def send(body: str) -> None:
        data = thingset_line(body, args.crc)
        if ser:
            with write_lock:
                ser.write(data)
        print(f"BMS -> {body[:150]}{'...' if len(body) > 150 else ''}")

    device = {"cManufacturer": "Libre Solar", "cDeviceType": "BMS-C1", "cHardwareVersion": "v0.4",
              "cFirmwareVersion": "v23.1-sim"}
    conf = {"sNominalCapacity_Ah": args.capacity, "sCellOvervoltage_V": LFP_LIMITS["cell_ov"],
            "sCellOvervoltageReset_V": LFP_LIMITS["cell_ov_reset"], "sCellUndervoltage_V": LFP_LIMITS["cell_uv"],
            "sCellUndervoltageReset_V": LFP_LIMITS["cell_uv_reset"], "sDisMaxTemp_degC": LFP_LIMITS["dis_ot"],
            "sChgMaxTemp_degC": LFP_LIMITS["chg_ot"], "sDisOvercurrent_A": args.capacity,
            "sChgOvercurrent_A": args.capacity, "sBalTargetVoltageDiff_V": 0.01, "sBalIdleCurrent_A": 0.1}

    def reader() -> None:
        """Answers ThingSet requests; everything else is gateway log output."""
        buf = b""
        while ser and ser.is_open:
            try:
                buf += ser.read(256)
            except Exception:
                return
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode(errors="replace").strip()
                if not line:
                    continue
                if line.startswith("?Device"):
                    send(":85 " + json.dumps(device, separators=(",", ":")))
                elif line.startswith("?Conf"):
                    send(":85 " + json.dumps(conf, separators=(",", ":")))
                elif line.startswith("?"):
                    send(":A4")  # Not Found
                else:
                    print(f"   GW | {line}")

    if ser:
        threading.Thread(target=reader, daemon=True).start()

    print(f"Simulating Libre Solar BMS: {args.cells}S LFP {args.capacity} Ah, scenario={args.scenario}, "
          f"report every {args.interval}s{' (CRC)' if args.crc else ''}. Ctrl+C to stop.")
    start = time.monotonic()
    sim_t = 0.0
    try:
        while True:
            t_wall = time.monotonic() - start
            dt = args.interval * args.speed
            sim_t += dt
            if args.fault:
                active = args.fault_at <= t_wall < args.fault_at + args.fault_for
                bit = {"undervoltage": ERR_CELL_UNDERVOLTAGE, "overvoltage": ERR_CELL_OVERVOLTAGE,
                       "overtemp": ERR_DIS_OVERTEMP}[args.fault]
                if active and not bat.forced_fault:
                    print(f"*** injecting fault: {args.fault}")
                if not active and bat.forced_fault:
                    print(f"*** clearing fault: {args.fault}")
                    bat.error_flags &= ~bit
                bat.forced_fault = bit if active else 0
            bat.step(profile_current(args.scenario, sim_t, args.current, args.capacity), dt, args.ambient)
            report = "#mLive " + json.dumps({"Meas": bat.meas()}, separators=(",", ":"))
            send(report)
            time.sleep(max(0.0, args.interval - ((time.monotonic() - start) - t_wall)))
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        if ser:
            ser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
