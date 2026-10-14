/**
 * Libre Solar BMS ThingSet reference data for presentation.
 * Mirrors software/backend/src/contracts/thingset.js, which was verified
 * against LibreSolar/bms-firmware main@779d201 (include/bms/bms_common.h,
 * include/bms/bms.h, app/src/data_objects.c). Nothing here is invented.
 */
import type { AggregatableField, ScalarField } from '../api/types';

export interface FieldMeta {
  label: string;
  short: string;
  unit: string;
  decimals: number;
  thingsetId: string;
  /** Quantity group: charts put fields with the same group on one axis. */
  group: 'voltage' | 'cellVoltage' | 'current' | 'soc' | 'temperature' | 'bitmap' | 'enum';
}

export const FIELDS: Record<ScalarField, FieldMeta> = {
  rPackVoltage_V: {
    label: 'Pack voltage',
    short: 'V pack',
    unit: 'V',
    decimals: 2,
    thingsetId: '0x71',
    group: 'voltage',
  },
  rStackVoltage_V: {
    label: 'Stack voltage',
    short: 'V stack',
    unit: 'V',
    decimals: 2,
    thingsetId: '0x72',
    group: 'voltage',
  },
  rPackCurrent_A: {
    label: 'Pack current',
    short: 'I pack',
    unit: 'A',
    decimals: 2,
    thingsetId: '0x73',
    group: 'current',
  },
  rICTemp_degC: {
    label: 'BMS IC temperature',
    short: 'T IC',
    unit: '°C',
    decimals: 1,
    thingsetId: '0x75',
    group: 'temperature',
  },
  rMOSFETTemp_degC: {
    label: 'MOSFET temperature',
    short: 'T FET',
    unit: '°C',
    decimals: 1,
    thingsetId: '0x77',
    group: 'temperature',
  },
  rShuntTemp_degC: {
    label: 'Shunt temperature',
    short: 'T shunt',
    unit: '°C',
    decimals: 1,
    thingsetId: '0x78',
    group: 'temperature',
  },
  rSOC_pct: { label: 'State of charge', short: 'SOC', unit: '%', decimals: 1, thingsetId: '0x7C', group: 'soc' },
  rErrorFlags: { label: 'Error flags', short: 'Errors', unit: '', decimals: 0, thingsetId: '0x7E', group: 'bitmap' },
  rBmsState: { label: 'BMS state', short: 'State', unit: '', decimals: 0, thingsetId: '0x7F', group: 'enum' },
  rCellAvgVoltage_V: {
    label: 'Cell voltage avg',
    short: 'V cell avg',
    unit: 'V',
    decimals: 3,
    thingsetId: '0x81',
    group: 'cellVoltage',
  },
  rCellMinVoltage_V: {
    label: 'Cell voltage min',
    short: 'V cell min',
    unit: 'V',
    decimals: 3,
    thingsetId: '0x82',
    group: 'cellVoltage',
  },
  rCellMaxVoltage_V: {
    label: 'Cell voltage max',
    short: 'V cell max',
    unit: 'V',
    decimals: 3,
    thingsetId: '0x83',
    group: 'cellVoltage',
  },
  rBalancingStatus: {
    label: 'Balancing status',
    short: 'Balancing',
    unit: '',
    decimals: 0,
    thingsetId: '0x84',
    group: 'bitmap',
  },
};

export const AGGREGATABLE: AggregatableField[] = [
  'rPackVoltage_V',
  'rStackVoltage_V',
  'rPackCurrent_A',
  'rSOC_pct',
  'rCellAvgVoltage_V',
  'rCellMinVoltage_V',
  'rCellMaxVoltage_V',
  'rICTemp_degC',
  'rMOSFETTemp_degC',
  'rShuntTemp_degC',
];

export const GROUP_UNIT: Record<FieldMeta['group'], string> = {
  voltage: 'V',
  cellVoltage: 'V',
  current: 'A',
  soc: '%',
  temperature: '°C',
  bitmap: '',
  enum: '',
};

/** enum bms_state (include/bms/bms.h) */
export const BMS_STATES: Record<number, { code: string; label: string; description: string }> = {
  0: { code: 'OFF', label: 'Off', description: 'Charging and discharging disabled' },
  1: { code: 'CHG', label: 'Charge only', description: 'Charging enabled, discharging disabled' },
  2: { code: 'DIS', label: 'Discharge only', description: 'Discharging enabled, charging disabled' },
  3: { code: 'NORMAL', label: 'Normal', description: 'Charging and discharging enabled' },
  4: { code: 'SHUTDOWN', label: 'Shutdown', description: 'BMS starting shutdown sequence' },
};

export interface ErrorFlagDef {
  bit: number;
  code: string;
  title: string;
  description: string;
  /** Presentation severity: protection trips are critical. */
  severity: 'critical' | 'warning';
}

/** BMS_ERR_* bits (include/bms/bms_common.h). Descriptions paraphrase the firmware comments. */
export const ERROR_FLAGS: ErrorFlagDef[] = [
  {
    bit: 0,
    code: 'BMS_ERR_CELL_UNDERVOLTAGE',
    title: 'Cell undervoltage',
    description: 'A cell is below the configured undervoltage limit (sCellUndervoltage_V).',
    severity: 'critical',
  },
  {
    bit: 1,
    code: 'BMS_ERR_CELL_OVERVOLTAGE',
    title: 'Cell overvoltage',
    description: 'A cell is above the configured overvoltage limit (sCellOvervoltage_V).',
    severity: 'critical',
  },
  {
    bit: 2,
    code: 'BMS_ERR_SHORT_CIRCUIT',
    title: 'Short circuit',
    description: 'Pack short circuit detected in discharge direction.',
    severity: 'critical',
  },
  {
    bit: 3,
    code: 'BMS_ERR_DIS_OVERCURRENT',
    title: 'Discharge overcurrent',
    description: 'Pack current exceeded the discharge overcurrent limit.',
    severity: 'critical',
  },
  {
    bit: 4,
    code: 'BMS_ERR_CHG_OVERCURRENT',
    title: 'Charge overcurrent',
    description: 'Pack current exceeded the charge overcurrent limit.',
    severity: 'critical',
  },
  {
    bit: 5,
    code: 'BMS_ERR_OPEN_WIRE',
    title: 'Open wire',
    description: 'A cell sense wire is open.',
    severity: 'critical',
  },
  {
    bit: 6,
    code: 'BMS_ERR_DIS_UNDERTEMP',
    title: 'Discharge undertemperature',
    description: 'Temperature below the discharge minimum limit.',
    severity: 'warning',
  },
  {
    bit: 7,
    code: 'BMS_ERR_DIS_OVERTEMP',
    title: 'Discharge overtemperature',
    description: 'Temperature above the discharge maximum limit.',
    severity: 'critical',
  },
  {
    bit: 8,
    code: 'BMS_ERR_CHG_UNDERTEMP',
    title: 'Charge undertemperature',
    description: 'Temperature below the charge minimum limit.',
    severity: 'warning',
  },
  {
    bit: 9,
    code: 'BMS_ERR_CHG_OVERTEMP',
    title: 'Charge overtemperature',
    description: 'Temperature above the charge maximum limit.',
    severity: 'critical',
  },
  {
    bit: 10,
    code: 'BMS_ERR_INT_OVERTEMP',
    title: 'Internal overtemperature',
    description: 'Internal temperature (e.g. BMS IC) above limit.',
    severity: 'critical',
  },
  {
    bit: 11,
    code: 'BMS_ERR_CELL_FAILURE',
    title: 'Cell failure',
    description: 'Cell failure: voltage difference between cells too high.',
    severity: 'critical',
  },
  {
    bit: 12,
    code: 'BMS_ERR_DIS_OFF',
    title: 'Discharge FET off',
    description: 'Discharge FET is off even though it should be on.',
    severity: 'critical',
  },
  {
    bit: 13,
    code: 'BMS_ERR_CHG_OFF',
    title: 'Charge FET off',
    description: 'Charge FET is off even though it should be on.',
    severity: 'critical',
  },
  {
    bit: 14,
    code: 'BMS_ERR_FET_OVERTEMP',
    title: 'MOSFET overtemperature',
    description: 'MOSFET temperature above limit.',
    severity: 'critical',
  },
];

export const ERROR_BY_CODE: Record<string, ErrorFlagDef> = Object.fromEntries(ERROR_FLAGS.map((f) => [f.code, f]));

export function isBitSet(value: number, bit: number): boolean {
  return Math.floor(value / 2 ** bit) % 2 === 1;
}

export function bmsStateLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return BMS_STATES[value]?.label ?? `Unknown (${value})`;
}

/** Event code category, used to separate BMS faults from gateway/communication events. */
export function eventCategory(code: string): 'bms_fault' | 'bms_state' | 'gateway' | 'other' {
  if (code.startsWith('BMS_ERR_')) return 'bms_fault';
  if (code.startsWith('BMS_STATE')) return 'bms_state';
  if (code.startsWith('GATEWAY_')) return 'gateway';
  return 'other';
}
