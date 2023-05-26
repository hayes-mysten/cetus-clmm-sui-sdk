import { normalizeSuiObjectId } from '@mysten/sui.js'
import { SuiAddressType, SuiStructTag } from '../types/sui'
import { checkAddress } from './hex'
import { CoinAssist } from '../math/CoinAssist'

const EQUAL = 0
const LESS_THAN = 1
const GREATER_THAN = 2

function cmp(a: number, b: number) {
  if (a === b) {
    return EQUAL
  }
  if (a < b) {
    return LESS_THAN
  }
  return GREATER_THAN
}

function compare(symbolX: string, symbolY: string) {
  let i = 0

  const len = symbolX.length <= symbolY.length ? symbolX.length : symbolY.length

  const lenCmp = cmp(symbolX.length, symbolY.length)
  while (i < len) {
    const elemCmp = cmp(symbolX.charCodeAt(i), symbolY.charCodeAt(i))
    i += 1
    if (elemCmp !== 0) {
      return elemCmp
    }
  }

  return lenCmp
}

export function isSortedSymbols(symbolX: string, symbolY: string) {
  return compare(symbolX, symbolY) === LESS_THAN
}

export function composeType(address: string, generics: SuiAddressType[]): SuiAddressType
export function composeType(address: string, struct: string, generics?: SuiAddressType[]): SuiAddressType
export function composeType(address: string, module: string, struct: string, generics?: SuiAddressType[]): SuiAddressType
export function composeType(address: string, ...args: unknown[]): SuiAddressType {
  const generics: string[] = Array.isArray(args[args.length - 1]) ? (args.pop() as string[]) : []
  const chains = [address, ...args].filter(Boolean)

  let result: string = chains.join('::')

  if (generics && generics.length) {
    result += `<${generics.join(', ')}>`
  }

  return result
}

export function extractAddressFromType(type: string) {
  return type.split('::')[0]
}

export function extractStructTagFromType(type: string): SuiStructTag {
  let _type = type.replace(/\s/g, '')

  const genericsString = _type.match(/(<.+>)$/)
  const generics = genericsString?.[0]?.match(/(\w+::\w+::\w+)(?:<.*?>(?!>))?/g)
  if (generics) {
    _type = _type.slice(0, _type.indexOf('<'))
    const tag = extractStructTagFromType(_type)
    const structTag: SuiStructTag = {
      ...tag,
      type_arguments: generics.map((item) => extractStructTagFromType(item).source_address),
    }
    structTag.type_arguments = structTag.type_arguments.map((item) => {
      return CoinAssist.isSuiCoin(item) ? item : extractStructTagFromType(item).source_address
    })
    structTag.source_address = composeType(structTag.full_address, structTag.type_arguments)
    return structTag
  }
  const parts = _type.split('::')

  const structTag: SuiStructTag = {
    full_address: _type,
    address: parts[2] === 'SUI' ? '0x2' : normalizeSuiObjectId(parts[0]),
    module: parts[1],
    name: parts[2],
    type_arguments: [],
    source_address: '',
  }
  structTag.full_address = `${structTag.address}::${structTag.module}::${structTag.name}`
  structTag.source_address = composeType(structTag.full_address, structTag.type_arguments)
  return structTag
}

export function normalizeCoinType(coinType: string): string {
  return extractStructTagFromType(coinType).source_address
}

export function fixSuiObjectId(value: string): string {
  if (value.toLowerCase().startsWith('0x')) {
    return normalizeSuiObjectId(value)
  }
  return value
}

export function patchFixSuiObjectId(data: any) {
  // eslint-disable-next-line guard-for-in
  for (const key in data) {
    const type = typeof data[key]
    if (type === 'object') {
      patchFixSuiObjectId(data[key])
    } else if (type === 'string') {
      const value = data[key]
      data[key] = fixSuiObjectId(value)
    }
  }
}
