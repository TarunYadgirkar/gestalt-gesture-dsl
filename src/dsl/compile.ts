import type { GestureDef } from './schema.js';
import type { MachineDescription } from '../types.js';

export interface CompiledMachine {
  name: string;
  hands: 1 | 2;
  priority: number;
  describe(): MachineDescription;
  toDSL(): GestureDef;
}

export function compile(_def: GestureDef): CompiledMachine {
  throw new Error('not implemented: compile');
}
