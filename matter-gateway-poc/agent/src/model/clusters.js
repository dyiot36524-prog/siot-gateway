// Matter 클러스터/속성/디바이스타입 ID (10진수; 경로 키 "endpoint/cluster/attribute" 형식과 맞춤)
export const CL = {
  DESCRIPTOR: 29,            // 0x001D
  BASIC_INFO: 40,            // 0x0028
  POWER_SOURCE: 47,          // 0x002F
  ON_OFF: 6,                 // 0x0006
  LEVEL: 8,                  // 0x0008
  BOOLEAN_STATE: 69,         // 0x0045
  ELEC_POWER: 144,           // 0x0090
  ELEC_ENERGY: 145,          // 0x0091
  ILLUMINANCE: 1024,         // 0x0400
  TEMPERATURE: 1026,         // 0x0402
  HUMIDITY: 1029,            // 0x0405
  OCCUPANCY: 1030,           // 0x0406
};

export const ATTR = {
  DESCRIPTOR_DEVICE_TYPE_LIST: 0,
  BASIC_VENDOR_NAME: 1, BASIC_VENDOR_ID: 2, BASIC_PRODUCT_NAME: 3, BASIC_NODE_LABEL: 5,
  BASIC_HW_VERSION_STR: 8, BASIC_SW_VERSION_STR: 10, BASIC_SERIAL: 15, BASIC_PRODUCT_ID: 4,
  POWER_BAT_PERCENT: 12, POWER_BAT_CHARGE_LEVEL: 14,
  ON_OFF_ON: 0,
  LEVEL_CURRENT: 0,
  BOOLEAN_STATE_VALUE: 0,
  ELEC_POWER_ACTIVE_POWER: 8, ELEC_POWER_VOLTAGE: 4, ELEC_POWER_ACTIVE_CURRENT: 5,
  ELEC_ENERGY_CUMULATIVE_IMPORTED: 1,
  MEASURED_VALUE: 0,
};

export const DEVICE_TYPE = {
  16: 'root',          // 0x0016 Root Node (22) -- 주의: 아래 표 참고
};
// 디바이스 타입 ID → 중립 모델 종류
export const DEVICE_TYPE_NAME = {
  22: 'root_node',
  17: 'power_source',
  256: 'onoff_light',
  257: 'dimmable_light',
  266: 'onoff_plug',
  267: 'dimmable_plug',
  21: 'contact_sensor',
  263: 'occupancy_sensor',
  262: 'light_sensor',
  770: 'temperature_sensor',
  775: 'humidity_sensor',
  1296: 'electrical_sensor',
  259: 'onoff_switch',   // 0x0103
  15: 'generic_switch',  // 0x000F
};
