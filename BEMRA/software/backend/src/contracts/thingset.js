/**
 * Libre Solar BMS ThingSet object catalogue.
 *
 * Verified against LibreSolar/bms-firmware, branch main @ 779d201 (2026-08-18):
 *   app/src/data_objects.h / data_objects.c, include/bms/bms.h,
 *   include/bms/bms_common.h, include/drivers/bms_ic.h
 *
 * This file is reference data, not a transformation: the backend never changes
 * values or units. `column` names the typed telemetry column a value is copied
 * into (unchanged); objects without a column are still preserved in JSONB.
 *
 * `conditional` marks objects compiled only when the named Kconfig option is
 * enabled, so they may legitimately be absent from a given firmware build.
 */
export const FIRMWARE_REFERENCE = Object.freeze({
  repository: 'https://github.com/LibreSolar/bms-firmware',
  ref: 'main@779d20199bff2666e01371ce2f562dcda4d6bda3',
  verified_on: '2026-10-09',
});

/** ThingSet "Meas" group (0x07): read-only live measurements (TS_SUBSET_LIVE). */
export const MEAS_OBJECTS = Object.freeze([
  {
    id: 0x71,
    name: 'rPackVoltage_V',
    type: 'float32',
    unit: 'V',
    decimals: 2,
    column: 'pack_voltage_v',
    note: 'Bound to ic_data.total_voltage, documented in bms_ic.h as the internal stack voltage.',
  },
  {
    id: 0x72,
    name: 'rStackVoltage_V',
    type: 'float32',
    unit: 'V',
    decimals: 2,
    column: 'stack_voltage_v',
    conditional: 'CONFIG_BMS_IC_SWITCHES',
    note: 'Bound to ic_data.external_voltage, documented in bms_ic.h as the external pack voltage.',
  },
  {
    id: 0x73,
    name: 'rPackCurrent_A',
    type: 'float32',
    unit: 'A',
    decimals: 2,
    column: 'pack_current_a',
    conditional: 'CONFIG_BMS_IC_SWITCHES',
    note: 'Charging direction is positive.',
  },
  {
    id: 0x74,
    name: 'rCellTemps_degC',
    type: 'float32[]',
    unit: '°C',
    decimals: 1,
    column: 'cell_temps_degc',
    note: 'One element per thermistor (not per cell). Firmware buffer size CONFIG_BMS_IC_MAX_THERMISTORS (default 3); gateway trims to provisioned count.',
  },
  { id: 0x75, name: 'rICTemp_degC', type: 'float32', unit: '°C', decimals: 1, column: 'ic_temp_degc' },
  {
    id: 0x77,
    name: 'rMOSFETTemp_degC',
    type: 'float32',
    unit: '°C',
    decimals: 1,
    column: 'mosfet_temp_degc',
    conditional: 'CONFIG_BMS_IC_SWITCHES',
  },
  {
    id: 0x78,
    name: 'rShuntTemp_degC',
    type: 'float32',
    unit: '°C',
    decimals: 1,
    column: 'shunt_temp_degc',
    conditional: 'CONFIG_BMS_IC_SHUNT_TEMP',
  },
  { id: 0x7c, name: 'rSOC_pct', type: 'float32', unit: '%', decimals: 1, column: 'soc_pct', note: 'Clamped to 0..100 by firmware.' },
  { id: 0x7e, name: 'rErrorFlags', type: 'uint32', unit: null, column: 'error_flags', note: 'Bitmap of BMS_ERR_* flags.' },
  { id: 0x7f, name: 'rBmsState', type: 'uint8', unit: null, column: 'bms_state', note: 'enum bms_state, see BMS_STATES.' },
  {
    id: 0x80,
    name: 'rCellVoltages_V',
    type: 'float32[]',
    unit: 'V',
    decimals: 3,
    column: 'cell_voltages',
    note: 'Firmware buffer size CONFIG_BMS_IC_MAX_CELLS (16 on bq769x2); gateway trims to provisioned cell count.',
  },
  { id: 0x81, name: 'rCellAvgVoltage_V', type: 'float32', unit: 'V', decimals: 3, column: 'cell_voltage_avg_v' },
  { id: 0x82, name: 'rCellMinVoltage_V', type: 'float32', unit: 'V', decimals: 3, column: 'cell_voltage_min_v' },
  { id: 0x83, name: 'rCellMaxVoltage_V', type: 'float32', unit: 'V', decimals: 3, column: 'cell_voltage_max_v' },
  { id: 0x84, name: 'rBalancingStatus', type: 'uint32', unit: null, column: 'balancing_status', note: 'Bitmap of balancing channels.' },
]);

/** Defined in firmware source but commented out, so not supported. */
export const UNSUPPORTED_OBJECTS = Object.freeze([{ id: 0x76, name: 'rMCUTemp_degC', reason: 'commented out in data_objects.c' }]);

/** ThingSet "Device" group (0x04): read-only identity strings. */
export const DEVICE_OBJECTS = Object.freeze([
  { id: 0x40, name: 'cManufacturer', type: 'string', column: 'manufacturer' },
  { id: 0x41, name: 'cDeviceType', type: 'string', column: 'device_type' },
  { id: 0x42, name: 'cHardwareVersion', type: 'string', column: 'hardware_version' },
  { id: 0x43, name: 'cFirmwareVersion', type: 'string', column: 'firmware_version' },
]);

/**
 * ThingSet "Conf" group (0x05): writable settings. BEMRA stores read-only
 * snapshots for display/alarm limits and exposes NO write path to the BMS.
 */
export const CONF_OBJECTS = Object.freeze([
  { id: 0x50, name: 'sNominalCapacity_Ah', type: 'float32', unit: 'Ah' },
  { id: 0xb0, name: 'sOcvPoints_V', type: 'float32[]', unit: 'V' },
  { id: 0xb1, name: 'sSocPoints_pct', type: 'float32[]', unit: '%' },
  { id: 0x51, name: 'sShortCircuitLimit_A', type: 'float32', unit: 'A' },
  { id: 0x52, name: 'sShortCircuitDelay_us', type: 'uint32', unit: 'µs' },
  { id: 0x53, name: 'sDisOvercurrent_A', type: 'float32', unit: 'A' },
  { id: 0x54, name: 'sDisOvercurrentDelay_ms', type: 'uint32', unit: 'ms' },
  { id: 0x55, name: 'sChgOvercurrent_A', type: 'float32', unit: 'A' },
  { id: 0x56, name: 'sChgOvercurrentDelay_ms', type: 'uint32', unit: 'ms' },
  { id: 0x58, name: 'sDisMaxTemp_degC', type: 'float32', unit: '°C' },
  { id: 0x59, name: 'sDisMinTemp_degC', type: 'float32', unit: '°C' },
  { id: 0x5a, name: 'sChgMaxTemp_degC', type: 'float32', unit: '°C' },
  { id: 0x5b, name: 'sChgMinTemp_degC', type: 'float32', unit: '°C' },
  { id: 0x5c, name: 'sTempLimitHysteresis_degC', type: 'float32', unit: '°C' },
  { id: 0x60, name: 'sCellOvervoltage_V', type: 'float32', unit: 'V' },
  { id: 0x61, name: 'sCellOvervoltageReset_V', type: 'float32', unit: 'V' },
  { id: 0x62, name: 'sCellOvervoltageDelay_ms', type: 'uint32', unit: 'ms' },
  { id: 0x63, name: 'sCellUndervoltage_V', type: 'float32', unit: 'V' },
  { id: 0x64, name: 'sCellUndervoltageReset_V', type: 'float32', unit: 'V' },
  { id: 0x65, name: 'sCellUndervoltageDelay_ms', type: 'uint32', unit: 'ms' },
  { id: 0x68, name: 'sBalTargetVoltageDiff_V', type: 'float32', unit: 'V' },
  { id: 0x69, name: 'sBalMinVoltage_V', type: 'float32', unit: 'V' },
  { id: 0x6a, name: 'sBalIdleDelay_s', type: 'uint16', unit: 's' },
  { id: 0x6b, name: 'sBalIdleCurrent_A', type: 'float32', unit: 'A' },
]);

/** ThingSet "Input" group (0x09): writable switches. Never written by BEMRA. */
export const INPUT_OBJECTS = Object.freeze([
  { id: 0x90, name: 'wChgEnable', type: 'bool' },
  { id: 0x91, name: 'wDisEnable', type: 'bool' },
]);

/** enum bms_state (include/bms/bms.h). */
export const BMS_STATES = Object.freeze({
  0: { code: 'OFF', description: 'Off (charging and discharging disabled)' },
  1: { code: 'CHG', description: 'Charging (discharging disabled)' },
  2: { code: 'DIS', description: 'Discharging (charging disabled)' },
  3: { code: 'NORMAL', description: 'Normal (charging and discharging enabled)' },
  4: { code: 'SHUTDOWN', description: 'Starting shutdown sequence' },
});

/** BMS_ERR_* bit definitions (include/bms/bms_common.h). */
export const ERROR_FLAGS = Object.freeze([
  { bit: 0, code: 'BMS_ERR_CELL_UNDERVOLTAGE', description: 'Cell undervoltage' },
  { bit: 1, code: 'BMS_ERR_CELL_OVERVOLTAGE', description: 'Cell overvoltage' },
  { bit: 2, code: 'BMS_ERR_SHORT_CIRCUIT', description: 'Pack short circuit (discharge direction)' },
  { bit: 3, code: 'BMS_ERR_DIS_OVERCURRENT', description: 'Pack overcurrent (discharge direction)' },
  { bit: 4, code: 'BMS_ERR_CHG_OVERCURRENT', description: 'Pack overcurrent (charge direction)' },
  { bit: 5, code: 'BMS_ERR_OPEN_WIRE', description: 'Cell open wire' },
  { bit: 6, code: 'BMS_ERR_DIS_UNDERTEMP', description: 'Temperature below discharge minimum limit' },
  { bit: 7, code: 'BMS_ERR_DIS_OVERTEMP', description: 'Temperature above discharge maximum limit' },
  { bit: 8, code: 'BMS_ERR_CHG_UNDERTEMP', description: 'Temperature below charge minimum limit' },
  { bit: 9, code: 'BMS_ERR_CHG_OVERTEMP', description: 'Temperature above charge maximum limit' },
  { bit: 10, code: 'BMS_ERR_INT_OVERTEMP', description: 'Internal temperature above limit (e.g. BMS IC)' },
  { bit: 11, code: 'BMS_ERR_CELL_FAILURE', description: 'Cell failure (too high voltage difference)' },
  { bit: 12, code: 'BMS_ERR_DIS_OFF', description: 'Discharge FET is off even though it should be on' },
  { bit: 13, code: 'BMS_ERR_CHG_OFF', description: 'Charge FET is off even though it should be on' },
  { bit: 14, code: 'BMS_ERR_FET_OVERTEMP', description: 'MOSFET temperature above limit' },
]);

/** Read-only decoding helpers for API presentation (raw values are always returned too). */
export function describeBmsState(value) {
  if (value === null || value === undefined) return null;
  return BMS_STATES[value] ? { value, ...BMS_STATES[value] } : { value, code: 'UNKNOWN', description: 'Not defined in verified firmware' };
}

export function decodeErrorFlags(value) {
  if (value === null || value === undefined) return null;
  const active = ERROR_FLAGS.filter((f) => Math.floor(value / 2 ** f.bit) % 2 === 1).map((f) => f.code);
  const knownMask = ERROR_FLAGS.reduce((m, f) => m + 2 ** f.bit, 0);
  // Bits set outside the verified definitions are reported, not hidden.
  const unknownBits = [];
  for (let bit = 0; bit < 32; bit++) {
    if (Math.floor(value / 2 ** bit) % 2 === 1 && Math.floor(knownMask / 2 ** bit) % 2 === 0) unknownBits.push(bit);
  }
  return { value, active, unknown_bits: unknownBits };
}

export const MEAS_BY_NAME = Object.freeze(Object.fromEntries(MEAS_OBJECTS.map((o) => [o.name, o])));
