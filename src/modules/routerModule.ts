import BN from 'bn.js'
import { Graph, GraphEdge, GraphVertex } from '@syntsugar/cc-graph'
import { TransactionBlock } from '@mysten/sui.js'
import { PreSwapWithMultiPoolParams } from '../types'
import { extractStructTagFromType, getOwnedObjects, queryEvents } from '../utils'
import { CLOCK_ADDRESS, ClmmExpectSwapModule, ClmmIntegrateRouterModule, SuiAddressType } from '../types/sui'
import { CetusClmmSDK } from '../sdk'
import { IModule } from '../interfaces/IModule'
import { U64_MAX, ZERO } from '../math'

const FLOAT_SCALING_U128 = new BN(1000000000)

function unsafe_mul_round(x: number, y: number): [boolean, BN] {
  const xB = new BN(x)
  const yB = new BN(y)
  let is_round_down = true
  if (xB.mul(yB).mod(FLOAT_SCALING_U128).eq(new BN(0))) {
    is_round_down = false
  }
  return [is_round_down, xB.mul(yB).div(FLOAT_SCALING_U128)]
}

function unsafe_div_round(x: number, y: number): [boolean, BN] {
  const xB = new BN(x)
  const yB = new BN(y)
  let is_round_down = true
  if (xB.mul(FLOAT_SCALING_U128).mod(yB).eq(new BN(0))) {
    is_round_down = false
  }
  return [is_round_down, xB.mul(FLOAT_SCALING_U128).div(yB)]
}

function unsafe_div(x: number, y: number): number {
  const [, result] = unsafe_div_round(x, y)
  return Number(result)
}

function unsafe_mul(x: number, y: number): number {
  const [, result] = unsafe_mul_round(x, y)
  return Number(result)
}

export type Order = {
  quantity: number
  price: number
}

// prepare router data
// includes coin and path
export interface CoinNode {
  address: string
  decimals: number
}

export interface CoinProvider {
  coins: CoinNode[]
}

export interface PathLink {
  base: string
  quote: string
  addressMap: Map<number, string>
}

export interface PathProvider {
  paths: PathLink[]
}

export type OnePath = {
  amountIn: BN
  amountOut: BN
  poolAddress: string[]
  a2b: boolean[]
  rawAmountLimit: BN[]
  isExceed: boolean
  coinType: string[]
  poolType: string[]
}

export type AddressAndDirection = {
  addressMap: Map<number, string>
  direction: boolean
}

export type SwapWithRouterParams = {
  paths: OnePath[]
  partner: string
  priceSplitPoint: number
}

export type PreRouterSwapParams = {
  stepNums: number
  poolAB: string
  poolBC: string | undefined
  a2b: boolean
  b2c: boolean | undefined
  byAmountIn: boolean
  amount: BN
  coinTypeA: SuiAddressType
  coinTypeB: SuiAddressType
  coinTypeC: SuiAddressType | undefined
}

export type PreSwapResult = {
  index: number
  amountIn: BN
  amountMedium: BN
  amountOut: BN
  targetSqrtPrice: BN[]
  currentSqrtPrice: BN[]
  isExceed: boolean
  stepNum: number
}

export type PriceResult = {
  amountIn: BN
  amountOut: BN
  paths: OnePath[]
  a2b: boolean
  b2c: boolean | undefined
  byAmountIn: boolean
  isExceed: boolean
  targetSqrtPrice: BN[]
  currentSqrtPrice: BN[]
  coinTypeA: SuiAddressType
  coinTypeB: SuiAddressType
  coinTypeC: SuiAddressType | undefined
  createTxParams: SwapWithRouterParams | undefined
}

function _pairSymbol(
  base: string,
  quote: string
): {
  pair: string
  reversePair: string
} {
  return {
    pair: `${base}-${quote}`,
    reversePair: `${quote}-${base}`,
  }
}

export class RouterModule implements IModule {
  readonly graph: Graph

  readonly pathProviders: PathProvider[]

  private coinProviders: CoinProvider

  private _coinAddressMap: Map<string, CoinNode>

  private poolAddressMap: Map<string, Map<number, string>>

  protected _sdk: CetusClmmSDK

  constructor(sdk: CetusClmmSDK) {
    this.pathProviders = []
    this.coinProviders = {
      coins: [],
    }
    this.graph = new Graph()
    this._coinAddressMap = new Map()
    this.poolAddressMap = new Map()
    this._sdk = sdk

    this.getPoolAddressMapAndDirection = this.getPoolAddressMapAndDirection.bind(this)
    this.setCoinList = this.setCoinList.bind(this)
    this.loadGraph = this.loadGraph.bind(this)
    this.addCoinProvider = this.addCoinProvider.bind(this)
    this.addPathProvider = this.addPathProvider.bind(this)
    this.preRouterSwapA2B2C = this.preRouterSwapA2B2C.bind(this)
    this.price = this.price.bind(this)
  }

  get sdk() {
    return this._sdk
  }

  async getDeepbookPools() {
    const deepbook = this._sdk.sdkOptions.deepbook.deepbook_display

    const allPools: any[] = []

    try {
      const objects = await queryEvents(this._sdk, { MoveEventType: `${deepbook}::clob_v2::PoolCreated` })

      objects.data.forEach((object: any) => {
        const fields = object.parsedJson
        if (fields) {
          allPools.push({
            poolAddress: fields.pool_id,
            tickSpacing: fields.tick_spacing,
            coinTypeA: extractStructTagFromType(fields.coin_type_a).full_address,
            coinTypeB: extractStructTagFromType(fields.coin_type_b).full_address,
          })
        }
      })
    } catch (error) {
      console.log('getPoolImmutables', error)
    }

    console.log('allPools', allPools)
  }

  async getDeepbookPoolsAsks() {
    const { simulationAccount } = this.sdk.sdkOptions
    const { deepbook_endpoint_v2 } = this._sdk.sdkOptions.deepbook

    const tx = new TransactionBlock()

    const coin_a = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT'
    const coin_b = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC'

    // const pool_address = '0xeb91fb7e1050fd6aa209d529a3f6bd8149a62f2f447f6abbe805a921983eb76c'
    const pool_address = '0x5a7604cb78bc96ebd490803cfa5254743262c17d3b5b5a954767f59e8285fa1b'

    const asks: Order[] = []

    const typeArguments = [coin_a, coin_b]
    const args = [tx.pure(pool_address), tx.pure('0'), tx.pure('999999999999'), tx.pure(CLOCK_ADDRESS)]
    tx.moveCall({
      target: `${deepbook_endpoint_v2}::endpoints_v2::get_level2_book_status_ask_side`,
      arguments: args,
      typeArguments,
    })

    const simulateRes = await this.sdk.fullClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: simulationAccount.address,
    })

    const valueData: any = simulateRes.events?.filter((item: any) => {
      return extractStructTagFromType(item.type).name === `BookStatus`
    })
    if (valueData.length === 0) {
      return null
    }

    for (let i = 0; i < valueData[0].parsedJson.depths.length; i++) {
      const price = valueData[0].parsedJson.price[i]
      const depth = valueData[0].parsedJson.depths[i]
      const ask: Order = {
        price: parseInt(price, 10),
        quantity: parseInt(depth, 10),
      }
      asks.push(ask)
    }

    // asks.sort((a, b) => {
    //   return a.price - b.price
    // })

    return asks
  }

  async getDeepbookPoolsBids() {
    const { simulationAccount } = this.sdk.sdkOptions
    const { deepbook_endpoint_v2 } = this._sdk.sdkOptions.deepbook

    const tx = new TransactionBlock()

    const coin_a = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT'
    const coin_b = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC'

    // const pool_address = '0xeb91fb7e1050fd6aa209d529a3f6bd8149a62f2f447f6abbe805a921983eb76c'
    const pool_address = '0x5a7604cb78bc96ebd490803cfa5254743262c17d3b5b5a954767f59e8285fa1b'

    const bids: Order[] = []

    const typeArguments = [coin_a, coin_b]
    const args = [tx.pure(pool_address), tx.pure('0'), tx.pure('999999999999'), tx.pure(CLOCK_ADDRESS)]
    tx.moveCall({
      target: `${deepbook_endpoint_v2}::endpoints_v2::get_level2_book_status_bid_side`,
      arguments: args,
      typeArguments,
    })

    const simulateRes = await this.sdk.fullClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: simulationAccount.address,
    })

    const valueData: any = simulateRes.events?.filter((item: any) => {
      return extractStructTagFromType(item.type).name === `BookStatus`
    })
    if (valueData.length === 0) {
      return null
    }

    for (let i = 0; i < valueData[0].parsedJson.depths.length; i++) {
      const price = valueData[0].parsedJson.price[i]
      const depth = valueData[0].parsedJson.depths[i]
      const bid: Order = {
        price: parseInt(price, 10),
        quantity: parseInt(depth, 10),
      }
      bids.push(bid)
    }

    // sort bids from highest to lowest
    // bids.sort((a, b) => {
    //   return b.price - a.price
    // })

    return bids
  }

  async getDeepbookAccountCap(accountAddress: string): Promise<string> {
    const ownerRes: any = await getOwnedObjects(this._sdk, accountAddress, {
      options: { showType: true, showContent: true, showDisplay: true, showOwner: true },
      filter: {
        MoveModule: {
          package: this._sdk.sdkOptions.deepbook.deepbook_display,
          module: 'custodian_v2',
        },
      },
    })

    if (ownerRes.data.length === 0) {
      return ''
    }

    const accountCap = ownerRes.data[0].data.objectId

    return accountCap
  }

  async deepbookPreswap(pool: string, is_bid: boolean, amount_in: number, taker_fee_rate: number) {
    const amount_in_t = amount_in
    amount_in *= 1000000000
    let amount_out = 0
    let target_sqrt_price = ZERO
    let current_sqrt_price = ZERO
    let is_exceed = false
    if (!is_bid) {
      // base to quote
      const asks = await this._sdk.Router.getDeepbookPoolsAsks()!
      if (asks!.length === 0) {
        is_exceed = true
        amount_out = 0
      } else {
        current_sqrt_price = new BN(Math.sqrt(asks![0].price))
        for (const ask of asks!) {
          if (amount_in > ask.quantity) {
            amount_in -= ask.quantity
            const filled_quote_amount = ask.quantity * ask.price
            // eslint-disable-next-line prefer-const
            let [is_round_down, fee] = unsafe_mul_round(filled_quote_amount, taker_fee_rate)
            if (is_round_down) {
              fee = fee.addn(1)
            }
            amount_out += filled_quote_amount - fee.toNumber()
          } else {
            const filled_quote_amount = amount_in * ask.price
            // eslint-disable-next-line prefer-const
            let [is_round_down, fee] = unsafe_mul_round(filled_quote_amount, taker_fee_rate)
            if (is_round_down) {
              fee = fee.addn(1)
            }
            amount_out += filled_quote_amount - fee.toNumber()

            target_sqrt_price = new BN(Math.sqrt(ask.price))
            break
          }
        }

        // if (amount_in > 0) {
        //   is_exceed = true
        //   amount_out = 0
        // }
      }
    } else {
      // quote to base
      const bids = await this._sdk.Router.getDeepbookPoolsBids()!
      if (bids!.length === 0) {
        is_exceed = true
        amount_out = 0
      } else {
        for (const bid of bids!) {
          const maker_quote_quantity_without_fee = bid.quantity * bid.price
          // eslint-disable-next-line prefer-const
          let [is_round_down, fee] = unsafe_mul_round(maker_quote_quantity_without_fee, taker_fee_rate)
          if (is_round_down) {
            fee = fee.addn(1)
          }
          const maker_quote_quantity = maker_quote_quantity_without_fee + Number(fee)

          let filled_base_quantity: number
          let filled_quote_quantity: number
          let filled_quote_quantity_without_fee: number
          if (amount_in > maker_quote_quantity) {
            filled_quote_quantity = maker_quote_quantity
            filled_quote_quantity_without_fee = maker_quote_quantity_without_fee
            filled_base_quantity = bid.quantity
            amount_out += filled_base_quantity
            amount_in -= filled_quote_quantity
          } else {
            filled_quote_quantity_without_fee = unsafe_div(amount_in, Number(FLOAT_SCALING_U128) + taker_fee_rate)
            filled_base_quantity = unsafe_div(filled_quote_quantity_without_fee, bid.price)
            const filled_base_lot = Math.floor(filled_base_quantity / 100000000)
            filled_base_quantity = filled_base_lot * 100000000
            filled_quote_quantity_without_fee = unsafe_mul(filled_base_quantity, bid.price)
            // eslint-disable-next-line prefer-const
            let [is_round_down, fee] = unsafe_mul_round(filled_quote_quantity_without_fee, taker_fee_rate)
            if (is_round_down) {
              fee = fee.addn(1)
            }
            filled_quote_quantity = filled_quote_quantity_without_fee + Number(fee)
            amount_out += filled_base_quantity
            amount_in -= filled_quote_quantity
            target_sqrt_price = new BN(Math.sqrt(bid.price))
            break
          }
        }

        // if (amount_in > 0) {
        //   is_exceed = true
        //   amount_out = 0
        // }
      }
    }

    amount_in /= 1000000000
    amount_out /= 1000000000

    return {
      poolAddress: pool,
      currentSqrtPrice: current_sqrt_price,
      estimatedAmountIn: amount_in_t,
      estimatedAmountOut: amount_out,
      estimatedEndSqrtPrice: target_sqrt_price,
      estimatedFeeAmount: 0,
      isExceed: is_exceed,
      amount: amount_in,
      aToB: is_bid,
      byAmountIn: true,
    }
  }

  getPoolAddressMapAndDirection(base: string, quote: string): AddressAndDirection | undefined {
    const { pair, reversePair } = _pairSymbol(base, quote)
    let addressMap: any = this.poolAddressMap.get(pair)

    if (addressMap != null) {
      return {
        addressMap,
        direction: true,
      }
    }

    addressMap = this.poolAddressMap.get(reversePair)
    if (addressMap != null) {
      return {
        addressMap,
        direction: false,
      }
    }
    return undefined
  }

  private setCoinList() {
    this.coinProviders.coins.forEach((coin) => {
      this._coinAddressMap.set(coin.address, coin)
    })
  }

  loadGraph(coins: CoinProvider, paths: PathProvider) {
    this.addCoinProvider(coins)
    this.addPathProvider(paths)
    this.setCoinList()

    this.pathProviders.forEach((provider) => {
      const { paths } = provider
      paths.forEach((path) => {
        const vertexA = this.graph.getVertexByKey(path.base) ?? new GraphVertex(path.base)
        const vertexB = this.graph.getVertexByKey(path.quote) ?? new GraphVertex(path.quote)

        this.graph.addEdge(new GraphEdge(vertexA, vertexB))

        const coinA: any = this._coinAddressMap.get(path.base)
        const coinB: any = this._coinAddressMap.get(path.quote)

        if (coinA != null && coinB != null) {
          const poolSymbol = _pairSymbol(path.base, path.quote).pair
          this.poolAddressMap.set(poolSymbol, path.addressMap)
        }
      })
    })
  }

  private addPathProvider(provider: PathProvider): RouterModule {
    // fix all order about base and quote in paths
    for (let i = 0; i < provider.paths.length; i += 1) {
      const { base, quote } = provider.paths[i]
      const compareResult = base.localeCompare(quote)
      if (compareResult < 0) {
        provider.paths[i].base = quote
        provider.paths[i].quote = base
      }

      if (base === '0x2::sui::SUI') {
        provider.paths[i].base = quote
        provider.paths[i].quote = base
      }

      if (quote === '0x2::sui::SUI') {
        provider.paths[i].base = base
        provider.paths[i].quote = quote
      }
    }

    this.pathProviders.push(provider)
    return this
  }

  private addCoinProvider(provider: CoinProvider): RouterModule {
    this.coinProviders = provider
    return this
  }

  tokenInfo(key: string): CoinNode | undefined {
    return this._coinAddressMap.get(key)
  }

  async price(
    base: string,
    quote: string,
    amount: BN,
    byAmountIn: boolean,
    priceSplitPoint: number,
    partner: string,
    swapWithMultiPoolParams?: PreSwapWithMultiPoolParams
  ): Promise<PriceResult | undefined> {
    if (
      (base === '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT' &&
        quote === '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC') ||
      (quote === '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT' &&
        base === '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC')
    ) {
      const a2b = base === '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT'

      const pool = await this.sdk.Pool.getPool('0x4038aea2341070550e9c1f723315624c539788d0ca9212dca7eb4b36147c0fcb')
      const decimalsA = 6
      const decimalsB = 6
      const by_amount_in = true
      const clmm_result = await this._sdk.Swap.preswap({
        pool,
        current_sqrt_price: pool.current_sqrt_price,
        decimalsA,
        decimalsB,
        a2b,
        by_amount_in,
        amount: amount.divn(2).toString(),
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
      })

      const deepbook_result = await this._sdk.Router.deepbookPreswap(
        '0x5a7604cb78bc96ebd490803cfa5254743262c17d3b5b5a954767f59e8285fa1b',
        a2b,
        amount.sub(amount.divn(2)).toNumber(),
        2500000
      )

      const clmmPath =
        clmm_result == null
          ? {
              amountIn: ZERO,
              amountOut: ZERO,
              poolAddress: [],
              a2b: [],
              rawAmountLimit: [],
              isExceed: true,
              coinType: [],
              poolType: [],
            }
          : {
              amountIn: new BN(clmm_result!.estimatedAmountIn),
              amountOut: new BN(clmm_result!.estimatedAmountOut),
              poolAddress: [clmm_result!.poolAddress],
              a2b: [clmm_result!.aToB],
              rawAmountLimit: [clmm_result!.estimatedAmountOut],
              isExceed: clmm_result!.isExceed,
              coinType: [base, quote],
              poolType: ['clmm'],
            }

      const deepbookPath: OnePath = {
        amountIn: new BN(deepbook_result!.estimatedAmountIn),
        amountOut: new BN(deepbook_result!.estimatedAmountOut),
        poolAddress: [deepbook_result!.poolAddress],
        a2b: [deepbook_result!.aToB],
        rawAmountLimit: [new BN(deepbook_result!.estimatedAmountOut)],
        isExceed: deepbook_result!.isExceed,
        coinType: [
          '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT',
          '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
        ],
        poolType: ['deepbook'],
      }

      const swapWithRouterParams = {
        paths: [clmmPath, deepbookPath],
        partner,
        priceSplitPoint,
      }

      const result: PriceResult = {
        amountIn: clmmPath.amountIn.add(new BN(deepbook_result!.estimatedAmountIn)),
        amountOut: clmmPath.amountOut.add(new BN(deepbook_result!.estimatedAmountOut)),
        paths: clmmPath == null ? [deepbookPath] : [clmmPath, deepbookPath],
        a2b: clmmPath.a2b[0],
        b2c: undefined,
        byAmountIn,
        isExceed: clmmPath!.isExceed && deepbook_result!.isExceed,
        targetSqrtPrice: [],
        currentSqrtPrice: [new BN(pool.current_sqrt_price)],
        coinTypeA: base,
        coinTypeB: quote,
        coinTypeC: undefined,
        createTxParams: swapWithRouterParams,
      }
      return result
    }
    const baseCoin = this.tokenInfo(base)
    const quoteCoin = this.tokenInfo(quote)

    if (baseCoin === undefined || quoteCoin === undefined) {
      return undefined
    }

    const sourceVertex = this.graph.getVertexByKey(baseCoin.address)
    const targetVertex = this.graph.getVertexByKey(quoteCoin.address)

    // find all paths
    const pathIter = this.graph.findAllPath(sourceVertex, targetVertex)
    const allPaths = Array.from(pathIter)

    if (allPaths.length === 0) {
      return undefined
    }

    const preRouterSwapParams: PreRouterSwapParams[] = []

    for (let i = 0; i < allPaths.length; i += 1) {
      const path = allPaths[i]

      // only consider one and two pair path
      if (path.length > 3) {
        continue
      }
      const baseQuote = []
      const swapDirection = []

      const poolsAB: string[] = []
      const poolsBC: string[] = []

      for (let j = 0; j < path.length - 1; j += 1) {
        const base = path[j].value.toString()
        const quote = path[j + 1].value.toString()
        const addressMap = this.getPoolAddressMapAndDirection(base, quote)?.addressMap
        const direction = this.getPoolAddressMapAndDirection(base, quote)?.direction

        if (addressMap !== undefined && direction !== undefined) {
          swapDirection.push(direction)
          baseQuote.push(base)
          baseQuote.push(quote)
          addressMap.forEach((address) => {
            if (j === 0) {
              poolsAB.push(address)
            } else {
              poolsBC.push(address)
            }
          })
        }
      }

      for (const poolAB of poolsAB) {
        if (poolsBC.length > 0) {
          for (const poolBC of poolsBC) {
            const param: PreRouterSwapParams = {
              stepNums: 2,
              poolAB,
              poolBC,
              a2b: swapDirection[0],
              b2c: swapDirection[1],
              amount,
              byAmountIn,
              coinTypeA: baseQuote[0],
              coinTypeB: baseQuote[1],
              coinTypeC: baseQuote[3],
            }
            preRouterSwapParams.push(param)
          }
        } else {
          const param: PreRouterSwapParams = {
            stepNums: 1,
            poolAB,
            poolBC: undefined,
            a2b: swapDirection[0],
            b2c: undefined,
            amount,
            byAmountIn,
            coinTypeA: baseQuote[0],
            coinTypeB: baseQuote[1],
            coinTypeC: undefined,
          }
          preRouterSwapParams.push(param)
        }
      }
    }

    if (preRouterSwapParams.length === 0) {
      if (swapWithMultiPoolParams != null) {
        const preSwapResult = await this.sdk.Swap.preSwapWithMultiPool(swapWithMultiPoolParams)

        const onePath: OnePath = {
          amountIn: new BN(preSwapResult!.estimatedAmountIn),
          amountOut: new BN(preSwapResult!.estimatedAmountOut),
          poolAddress: [preSwapResult!.poolAddress],
          a2b: [preSwapResult!.aToB],
          rawAmountLimit: byAmountIn ? [preSwapResult!.estimatedAmountOut] : [preSwapResult!.estimatedAmountIn],
          isExceed: preSwapResult!.isExceed,
          coinType: [base, quote],
          poolType: ['clmm', 'clmm'],
        }

        const swapWithRouterParams = {
          paths: [onePath],
          partner,
          priceSplitPoint,
        }

        const result: PriceResult = {
          amountIn: new BN(preSwapResult!.estimatedAmountIn),
          amountOut: new BN(preSwapResult!.estimatedAmountOut),
          paths: [onePath],
          a2b: preSwapResult!.aToB,
          b2c: undefined,
          byAmountIn,
          isExceed: preSwapResult!.isExceed,
          targetSqrtPrice: [preSwapResult!.estimatedEndSqrtPrice],
          currentSqrtPrice: [preSwapResult!.estimatedStartSqrtPrice],
          coinTypeA: base,
          coinTypeB: quote,
          coinTypeC: undefined,
          createTxParams: swapWithRouterParams,
        }
        return result
      }
      return undefined
    }

    const preSwapResult = await this.preRouterSwapA2B2C(preRouterSwapParams.slice(0, 64))
    if (preSwapResult == null) {
      if (swapWithMultiPoolParams != null) {
        const preSwapResult = await this.sdk.Swap.preSwapWithMultiPool(swapWithMultiPoolParams)

        const onePath: OnePath = {
          amountIn: new BN(preSwapResult!.estimatedAmountIn),
          amountOut: new BN(preSwapResult!.estimatedAmountOut),
          poolAddress: [preSwapResult!.poolAddress],
          a2b: [preSwapResult!.aToB],
          rawAmountLimit: byAmountIn ? [preSwapResult!.estimatedAmountOut] : [preSwapResult!.estimatedAmountIn],
          isExceed: preSwapResult!.isExceed,
          coinType: [base, quote],
          poolType: ['clmm', 'clmm'],
        }

        const swapWithRouterParams = {
          paths: [onePath],
          partner,
          priceSplitPoint,
        }

        const result: PriceResult = {
          amountIn: new BN(preSwapResult!.estimatedAmountIn),
          amountOut: new BN(preSwapResult!.estimatedAmountOut),
          paths: [onePath],
          a2b: preSwapResult!.aToB,
          b2c: undefined,
          byAmountIn,
          isExceed: preSwapResult!.isExceed,
          targetSqrtPrice: [preSwapResult!.estimatedEndSqrtPrice],
          currentSqrtPrice: [preSwapResult!.estimatedStartSqrtPrice],
          coinTypeA: base,
          coinTypeB: quote,
          coinTypeC: undefined,
          createTxParams: swapWithRouterParams,
        }
        return result
      }
      const result: PriceResult = {
        amountIn: ZERO,
        amountOut: ZERO,
        paths: [],
        a2b: false,
        b2c: false,
        byAmountIn,
        isExceed: true,
        targetSqrtPrice: [],
        currentSqrtPrice: [],
        coinTypeA: '',
        coinTypeB: '',
        coinTypeC: undefined,
        createTxParams: undefined,
      }

      return result
    }

    const bestIndex = preSwapResult!.index

    const poolAddress =
      preRouterSwapParams[bestIndex].poolBC != null
        ? [preRouterSwapParams[bestIndex].poolAB, preRouterSwapParams[bestIndex].poolBC!]
        : [preRouterSwapParams[bestIndex].poolAB]

    const rawAmountLimit = byAmountIn
      ? [preSwapResult!.amountMedium, preSwapResult!.amountOut]
      : [preSwapResult!.amountIn, preSwapResult!.amountMedium]

    const a2bs = []
    a2bs.push(preRouterSwapParams[bestIndex].a2b)
    if (preSwapResult!.stepNum! > 1) {
      a2bs.push(preRouterSwapParams[bestIndex].b2c!)
    }

    const coinTypes = []
    coinTypes.push(preRouterSwapParams[bestIndex].coinTypeA)
    coinTypes.push(preRouterSwapParams[bestIndex].coinTypeB)
    if (preSwapResult!.stepNum! > 1) {
      coinTypes.push(preRouterSwapParams[bestIndex].coinTypeC!)
    }

    const onePath: OnePath = {
      amountIn: preSwapResult!.amountIn,
      amountOut: preSwapResult!.amountOut,
      poolAddress,
      a2b: a2bs,
      rawAmountLimit,
      isExceed: preSwapResult!.isExceed,
      coinType: coinTypes,
      poolType: ['clmm', 'clmm'],
    }

    const swapWithRouterParams = {
      paths: [onePath],
      partner,
      priceSplitPoint,
    }

    const result: PriceResult = {
      amountIn: preSwapResult!.amountIn,
      amountOut: preSwapResult!.amountOut,
      paths: [onePath],
      a2b: preRouterSwapParams[bestIndex].a2b,
      b2c: preSwapResult!.stepNum! > 1 ? preRouterSwapParams[bestIndex].b2c! : undefined,
      byAmountIn,
      isExceed: preSwapResult!.isExceed,
      targetSqrtPrice: preSwapResult!.targetSqrtPrice,
      currentSqrtPrice: preSwapResult!.currentSqrtPrice,
      coinTypeA: preRouterSwapParams[bestIndex].coinTypeA,
      coinTypeB: preRouterSwapParams[bestIndex].coinTypeB,
      coinTypeC: preSwapResult!.stepNum! > 1 ? preRouterSwapParams[bestIndex].coinTypeC! : undefined,
      createTxParams: swapWithRouterParams,
    }
    return result
  }

  async preRouterSwapA2B2C(params: PreRouterSwapParams[]) {
    if (params.length === 0) {
      return null
    }

    const { clmm, simulationAccount } = this.sdk.sdkOptions

    const tx = new TransactionBlock()
    for (const param of params) {
      if (param.stepNums > 1) {
        const args = [
          tx.object(param.poolAB),
          tx.object(param.poolBC!),
          tx.pure(param.a2b),
          tx.pure(param.b2c),
          tx.pure(param.byAmountIn),
          tx.pure(param.amount.toString()),
        ]
        const typeArguments = []
        if (param.a2b) {
          typeArguments.push(param.coinTypeA, param.coinTypeB)
        } else {
          typeArguments.push(param.coinTypeB, param.coinTypeA)
        }

        if (param.b2c) {
          typeArguments.push(param.coinTypeB, param.coinTypeC!)
        } else {
          typeArguments.push(param.coinTypeC!, param.coinTypeB)
        }

        console.log(args, typeArguments)

        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmIntegrateRouterModule}::calculate_router_swap_result`,
          typeArguments,
          arguments: args,
        })
      } else {
        const args = [tx.pure(param.poolAB), tx.pure(param.a2b), tx.pure(param.byAmountIn), tx.pure(param.amount.toString())]
        const typeArguments = param.a2b ? [param.coinTypeA, param.coinTypeB] : [param.coinTypeB, param.coinTypeA]
        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmExpectSwapModule}::get_expect_swap_result`,
          arguments: args,
          typeArguments,
        })
      }
    }

    const simulateRes = await this.sdk.fullClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: simulationAccount.address,
    })

    const valueData: any = simulateRes.events?.filter((item: any) => {
      return (
        extractStructTagFromType(item.type).name === `CalculatedRouterSwapResultEvent` ||
        extractStructTagFromType(item.type).name === `ExpectSwapResultEvent`
      )
    })
    if (valueData.length === 0) {
      return null
    }

    let tempMaxAmount = params[0].byAmountIn ? ZERO : U64_MAX
    let tempIndex = 0

    for (let i = 0; i < valueData.length; i += 1) {
      if (valueData[i].parsedJson.data.is_exceed) {
        continue
      }

      if (params[0].byAmountIn) {
        const amount = new BN(valueData[i].parsedJson.data.amount_out)
        if (amount.gt(tempMaxAmount)) {
          tempIndex = i
          tempMaxAmount = amount
        }
      } else {
        const amount =
          params[i].stepNums > 1
            ? new BN(valueData[i].parsedJson.data.amount_in)
            : new BN(valueData[i].parsedJson.data.amount_in).add(new BN(valueData[i].parsedJson.data.fee_amount))
        if (amount.lt(tempMaxAmount)) {
          tempIndex = i
          tempMaxAmount = amount
        }
      }
    }

    const currentSqrtPrice = []
    const targetSqrtPrice = []
    if (params[tempIndex].stepNums > 1) {
      targetSqrtPrice.push(
        valueData[tempIndex].parsedJson.data.target_sqrt_price_ab,
        valueData[tempIndex].parsedJson.data.target_sqrt_price_cd
      )
      currentSqrtPrice.push(
        valueData[tempIndex].parsedJson.data.current_sqrt_price_ab,
        valueData[tempIndex].parsedJson.data.current_sqrt_price_cd
      )
    } else {
      targetSqrtPrice.push(valueData[tempIndex].parsedJson.data.after_sqrt_price)
      currentSqrtPrice.push(valueData[tempIndex].parsedJson.current_sqrt_price)
    }

    const result: PreSwapResult = {
      index: tempIndex,
      amountIn: params[0].byAmountIn ? params[tempIndex].amount : tempMaxAmount,
      amountMedium: valueData[tempIndex].parsedJson.data.amount_medium,
      amountOut: params[0].byAmountIn ? tempMaxAmount : params[tempIndex].amount,
      targetSqrtPrice,
      currentSqrtPrice,
      isExceed: valueData[tempIndex].parsedJson.data.is_exceed,
      stepNum: params[tempIndex].stepNums,
    }
    return result
  }
}
