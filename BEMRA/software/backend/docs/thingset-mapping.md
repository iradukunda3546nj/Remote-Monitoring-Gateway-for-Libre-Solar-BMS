# ThingSet → MQTT → PostgreSQL mapping

Verified against **LibreSolar/bms-firmware `main` @ `779d201` (2026-08-18)**, files
`app/src/data_objects.{h,c}`, `include/bms/bms.h`, `include/bms/bms_common.h`,
`include/drivers/bms_ic.h`. Latest release tag: `v23.1`. Re-verify if the BMS
runs a different firmware revision; the catalogue lives in
[`src/contracts/thingset.js`](../src/contracts/thingset.js).

## Meas group (0x07), read-only, `TS_SUBSET_LIVE`

| ID   | ThingSet name       | Firmware type | Decimals | Unit   | Build condition     | `telemetry` column                      | Notes                                                                   |
| ---- | ------------------- | ------------- | -------- | ------ | ------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| 0x71 | `rPackVoltage_V`    | float         | 2        | V      | always              | `pack_voltage_v`                        | bound to `ic_data.total_voltage` ("internal stack voltage" in bms_ic.h) |
| 0x72 | `rStackVoltage_V`   | float         | 2        | V      | `BMS_IC_SWITCHES`   | `stack_voltage_v`                       | bound to `ic_data.external_voltage` ("external pack voltage")           |
| 0x73 | `rPackCurrent_A`    | float         | 2        | A      | `BMS_IC_SWITCHES`   | `pack_current_a`                        | **+ = charging**                                                        |
| 0x74 | `rCellTemps_degC`   | float[3]      | 1        | °C     | always              | `cell_temps_degc` (array)               | per thermistor                                                          |
| 0x75 | `rICTemp_degC`      | float         | 1        | °C     | always              | `ic_temp_degc`                          |                                                                         |
| 0x76 | ~~`rMCUTemp_degC`~~ |               |          |        | **commented out**   | none                                    | not supported; never fabricated                                         |
| 0x77 | `rMOSFETTemp_degC`  | float         | 1        | °C     | `BMS_IC_SWITCHES`   | `mosfet_temp_degc`                      |                                                                         |
| 0x78 | `rShuntTemp_degC`   | float         | 1        | °C     | `BMS_IC_SHUNT_TEMP` | `shunt_temp_degc`                       |                                                                         |
| 0x7C | `rSOC_pct`          | float         | 1        | %      | always              | `soc_pct`                               | clamped 0–100 by firmware                                               |
| 0x7E | `rErrorFlags`       | uint32        |          | bitmap | always              | `error_flags`                           | see below                                                               |
| 0x7F | `rBmsState`         | uint8         |          | enum   | always              | `bms_state`                             | 0 OFF · 1 CHG · 2 DIS · 3 NORMAL · 4 SHUTDOWN                           |
| 0x80 | `rCellVoltages_V`   | float[16]     | 3        | V      | always              | `cell_measurements` rows + `cell_count` | trimmed by gateway                                                      |
| 0x81 | `rCellAvgVoltage_V` | float         | 3        | V      | always              | `cell_voltage_avg_v`                    |                                                                         |
| 0x82 | `rCellMinVoltage_V` | float         | 3        | V      | always              | `cell_voltage_min_v`                    |                                                                         |
| 0x83 | `rCellMaxVoltage_V` | float         | 3        | V      | always              | `cell_voltage_max_v`                    |                                                                         |
| 0x84 | `rBalancingStatus`  | uint32        |          | bitmap | always              | `balancing_status`                      | channel→cell mapping is IC-specific; not decoded                        |

The **complete** received object, including any object without a column, is
stored in `telemetry.thingset` (JSONB). The typed columns are copies made for
fast queries; the JSONB is the record of what the gateway sent.

**Naming quirk, kept as-is:** the firmware binds `rPackVoltage_V` to the
internal stack voltage and `rStackVoltage_V` to the external pack voltage
(per comments in `bms_ic.h`). BEMRA preserves the firmware names exactly and
does not "correct" them. To be confirmed with Libre Solar maintainers.

## `rErrorFlags` bits (`BMS_ERR_*`, bms_common.h)

0 CELL_UNDERVOLTAGE · 1 CELL_OVERVOLTAGE · 2 SHORT_CIRCUIT · 3 DIS_OVERCURRENT ·
4 CHG_OVERCURRENT · 5 OPEN_WIRE · 6 DIS_UNDERTEMP · 7 DIS_OVERTEMP ·
8 CHG_UNDERTEMP · 9 CHG_OVERTEMP · 10 INT_OVERTEMP · 11 CELL_FAILURE ·
12 DIS_OFF · 13 CHG_OFF · 14 FET_OVERTEMP. The API reports bits outside this
list as `unknown_bits` instead of hiding them.

## Device group (0x04), read-only → `meta.device` → `devices.*`, `device_metadata.device_info`

`cManufacturer` (0x40) → `manufacturer` · `cDeviceType` (0x41) → `device_type` ·
`cHardwareVersion` (0x42) → `hardware_version` · `cFirmwareVersion` (0x43) → `firmware_version`.
Functions `xShutdown`, `xReset`, `xDebugPrintRegisters` are **never** invoked by BEMRA.

## Conf group (0x05), **writable** → `meta.conf` → `device_metadata.conf` (read-only snapshot)

`sNominalCapacity_Ah`, `sOcvPoints_V`, `sSocPoints_pct`, `sShortCircuitLimit_A`,
`sShortCircuitDelay_us`, `sDisOvercurrent_A`, `sDisOvercurrentDelay_ms`,
`sChgOvercurrent_A`, `sChgOvercurrentDelay_ms`, `sDisMaxTemp_degC`, `sDisMinTemp_degC`,
`sChgMaxTemp_degC`, `sChgMinTemp_degC`, `sTempLimitHysteresis_degC`, `sCellOvervoltage_V`,
`sCellOvervoltageReset_V`, `sCellOvervoltageDelay_ms`, `sCellUndervoltage_V`,
`sCellUndervoltageReset_V`, `sCellUndervoltageDelay_ms`, `sBalTargetVoltageDiff_V`,
`sBalMinVoltage_V`, `sBalIdleDelay_s`, `sBalIdleCurrent_A`; preset functions
`xPresetNMC/LFP/LTO`. `sNominalCapacity_Ah` is also copied to `devices.nominal_capacity_ah`.

## Input group (0x09), **writable**

`wChgEnable`, `wDisEnable`. Not transported and never written. The API has no
endpoint that modifies BMS configuration or inputs.

## Open questions

1. Which firmware revision and board variant (BMS‑C1 hardware version) will be used in the field? Some Meas objects depend on Kconfig.
2. Confirm the pack/stack voltage naming with Libre Solar.
3. The ThingSet live report has no device timestamp, so `measured_at` will stay `null` unless a future firmware adds one.
