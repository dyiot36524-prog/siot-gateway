// 중립 명령 {deviceId, endpoint, capability, action, params} → Matter device_command
import { CL } from './model/clusters.js';

export async function executeCommand(matter, registry, cmd) {
  const device = registry.get(cmd.deviceId);
  if (!device) throw new Error(`unknown device ${cmd.deviceId}`);
  if (device.source !== 'matter') throw new Error(`source ${device.source} not supported yet`);
  const nodeId = device.nodeId;
  const ep = cmd.endpoint ?? firstEndpointWith(device, cmd.capability);
  if (ep == null) throw new Error(`device has no endpoint with capability ${cmd.capability}`);
  const p = cmd.params ?? {};

  switch (`${cmd.capability}.${cmd.action}`) {
    case 'onoff.on': return matter.deviceCommand(nodeId, ep, CL.ON_OFF, 'On');
    case 'onoff.off': return matter.deviceCommand(nodeId, ep, CL.ON_OFF, 'Off');
    case 'onoff.toggle': return matter.deviceCommand(nodeId, ep, CL.ON_OFF, 'Toggle');
    case 'onoff.set': return matter.deviceCommand(nodeId, ep, CL.ON_OFF, p.on ? 'On' : 'Off');
    case 'level.set': {
      const level = Math.max(0, Math.min(254, Math.round((Number(p.percent) / 100) * 254)));
      return matter.deviceCommand(nodeId, ep, CL.LEVEL, 'MoveToLevelWithOnOff',
        { level, transitionTime: p.transitionTime ?? 0, optionsMask: 0, optionsOverride: 0 });
    }
    default:
      throw new Error(`unsupported command ${cmd.capability}.${cmd.action}`);
  }
}

function firstEndpointWith(device, capability) {
  for (const e of Object.values(device.endpoints)) if (e.capabilities[capability]) return e.id;
  return null;
}
