import type { Oven, OvenState, OvenProbe, SaveOvenInput, OvenRun } from '../ovens'
import type { Contract } from './contract-helpers'

export const invokeOvenContract = {
  'oven:state': {} as Contract<[], OvenState>,
  'oven:save': {} as Contract<[input: SaveOvenInput], Oven>,
  'oven:remove': {} as Contract<[id: string], OvenState>,
  'oven:setDefault': {} as Contract<[id: string], OvenState>,
  'oven:install': {} as Contract<[id: string], OvenProbe>,
  'oven:probe': {} as Contract<[id: string], OvenProbe>,
  'oven:runs': {} as Contract<[id: string], OvenRun[]>
}
