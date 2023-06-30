import {
  getTransactionEffects,
  JsonRpcProvider,
  RawSigner,
  TransactionArgument,
  TransactionBlock,
  TransactionEffects,
} from '@mysten/sui.js'
import BN from 'bn.js'
import { CoinAssist } from '../math/CoinAssist'
import { SwapWithRouterParams } from '../modules/routerModule'
import { TickData } from '../types/clmmpool'
import { ClmmIntegratePoolModule, ClmmIntegrateRouterModule, CLOCK_ADDRESS } from '../types/sui'
import SDK, {
  AddLiquidityFixTokenParams,
  adjustForSlippage,
  asUintN,
  ClmmPoolUtil,
  CoinAsset,
  CoinPairType,
  d,
  Percentage,
  Pool,
  SdkOptions,
  SwapParams,
  SwapUtils,
} from '../index'

export function findAdjustCoin(coinPair: CoinPairType): { isAdjustCoinA: boolean; isAdjustCoinB: boolean } {
  const isAdjustCoinA = CoinAssist.isSuiCoin(coinPair.coinTypeA)
  const isAdjustCoinB = CoinAssist.isSuiCoin(coinPair.coinTypeB)
  return { isAdjustCoinA, isAdjustCoinB }
}

export type BuildCoinInputResult = {
  transactionArgument: TransactionArgument[]
  remainCoins: CoinAsset[]
}

export async function sendTransaction(
  signer: RawSigner,
  tx: TransactionBlock,
  onlyCalculateGas = false
): Promise<TransactionEffects | undefined> {
  try {
    if (onlyCalculateGas) {
      tx.setSender(await signer.getAddress())
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      const gasAmount = await TransactionUtil.calculationTxGas(signer, tx)
      console.log('need gas : ', gasAmount)
      return undefined
    }

    const resultTxn = await signer.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      options: {
        showEffects: true,
        showEvents: true,
      },
    })
    return getTransactionEffects(resultTxn)
  } catch (error) {
    console.log('error: ', error)
  }
  return undefined
}

export async function printTransaction(tx: TransactionBlock) {
  tx.blockData.transactions.forEach((item, index) => {
    console.log(`transaction ${index}: `, item)
  })
}

export class TransactionUtil {
  /**
   * adjust transaction for gas
   * @param sdk
   * @param amount
   * @param tx
   * @returns
   */
  static async adjustTransactionForGas(
    sdk: SDK,
    allCoins: CoinAsset[],
    amount: bigint,
    tx: TransactionBlock
  ): Promise<{ fixAmount: bigint; fixCoinInput?: TransactionArgument; newTx?: TransactionBlock }> {
    tx.setSender(sdk.senderAddress)
    // amount coins
    const amountCoins = CoinAssist.selectCoinAssetGreaterThanOrEqual(allCoins, amount).selectedCoins
    if (amountCoins.length === 0) {
      throw new Error(`Insufficient balance`)
    }
    const totalAmount = CoinAssist.calculateTotalBalance(allCoins)
    // If the remaining coin balance is greater than 1000000000, no gas fee correction will be done
    if (totalAmount - amount > 1000000000) {
      return { fixAmount: amount }
    }

    // payload Estimated gas consumption
    const estimateGas = await TransactionUtil.calculationTxGas(sdk.fullClient, tx)

    // Find estimateGas objectIds
    const gasCoins = CoinAssist.selectCoinAssetGreaterThanOrEqual(
      allCoins,
      BigInt(estimateGas),
      amountCoins.map((item) => item.coinObjectId)
    ).selectedCoins

    // There is not enough gas and the amount needs to be adjusted
    if (gasCoins.length === 0) {
      // Readjust the amount , Reserve 500 gas for the spit
      const newGas = BigInt(estimateGas) + BigInt(500)
      if (totalAmount - amount < newGas) {
        amount -= newGas
        if (amount < 0) {
          throw new Error(`gas Insufficient balance`)
        }

        const newTx = new TransactionBlock()
        const primaryCoinAInput = newTx.splitCoins(newTx.gas, [newTx.pure(amount)])
        newTx.setGasBudget(newGas)
        return { fixAmount: amount, fixCoinInput: newTx.makeMoveVec({ objects: [primaryCoinAInput] }), newTx }
      }
    }
    return { fixAmount: amount }
  }

  // -----------------------------------------liquidity-----------------------------------------------
  /**
   * build add liquidity transaction
   * @param params
   * @param slippage
   * @param curSqrtPrice
   * @returns
   */
  static async buildAddLiquidityFixTokenForGas(
    sdk: SDK,
    allCoins: CoinAsset[],
    params: AddLiquidityFixTokenParams,
    gasEstimateArg: {
      slippage: number
      curSqrtPrice: BN
    }
  ): Promise<TransactionBlock> {
    let tx = await TransactionUtil.buildAddLiquidityFixToken(sdk, allCoins, params)

    const { isAdjustCoinA } = findAdjustCoin(params)

    const suiAmount = isAdjustCoinA ? params.amount_a : params.amount_b

    const newResult = await TransactionUtil.adjustTransactionForGas(
      sdk,
      CoinAssist.getCoinAssets(isAdjustCoinA ? params.coinTypeA : params.coinTypeB, allCoins),
      BigInt(suiAmount),
      tx
    )

    const { fixAmount } = newResult
    const { fixCoinInput } = newResult
    const { newTx } = newResult

    if (fixCoinInput !== undefined && newTx !== undefined) {
      let primaryCoinAInputs: TransactionArgument | undefined | any
      let primaryCoinBInputs: TransactionArgument | undefined | any

      if (isAdjustCoinA) {
        params.amount_a = Number(fixAmount)
        primaryCoinAInputs = fixCoinInput
        primaryCoinBInputs = TransactionUtil.buildCoinInputForAmount(
          newTx,
          allCoins,
          BigInt(params.amount_b),
          params.coinTypeB
        )?.transactionArgument
      } else {
        params.amount_b = Number(fixAmount)
        primaryCoinAInputs = TransactionUtil.buildCoinInputForAmount(
          newTx,
          allCoins,
          BigInt(params.amount_a),
          params.coinTypeA
        )?.transactionArgument
        primaryCoinBInputs = fixCoinInput
        params = TransactionUtil.fixAddLiquidityFixTokenParams(params, gasEstimateArg.slippage, gasEstimateArg.curSqrtPrice)

        tx = TransactionUtil.buildAddLiquidityFixTokenArgs(newTx, sdk, params, primaryCoinAInputs, primaryCoinBInputs)
        return tx
      }
    }
    return tx
  }

  /**
   * build add liquidity transaction
   * @param params
   * @param packageId
   * @returns
   */
  static async buildAddLiquidityFixToken(
    sdk: SDK,
    allCoinAsset: CoinAsset[],
    params: AddLiquidityFixTokenParams
  ): Promise<TransactionBlock> {
    if (sdk.senderAddress.length === 0) {
      throw Error('this config sdk senderAddress is empty')
    }

    let tx = new TransactionBlock()
    const primaryCoinAInputs: any = TransactionUtil.buildCoinInputForAmount(
      tx,
      allCoinAsset,
      BigInt(params.amount_a),
      params.coinTypeA
    )?.transactionArgument
    const primaryCoinBInputs: any = TransactionUtil.buildCoinInputForAmount(
      tx,
      allCoinAsset,
      BigInt(params.amount_b),
      params.coinTypeB
    )?.transactionArgument

    tx = TransactionUtil.buildAddLiquidityFixTokenArgs(
      tx,
      sdk,
      params as AddLiquidityFixTokenParams,
      primaryCoinAInputs,
      primaryCoinBInputs
    )
    return tx
  }

  /**
   * fix add liquidity fix token for coin amount
   * @param params
   * @param slippage
   * @param curSqrtPrice
   * @returns
   */
  static fixAddLiquidityFixTokenParams(params: AddLiquidityFixTokenParams, slippage: number, curSqrtPrice: BN): AddLiquidityFixTokenParams {
    const coinAmount = params.fix_amount_a ? params.amount_a : params.amount_b
    const liquidityInput = ClmmPoolUtil.estLiquidityAndcoinAmountFromOneAmounts(
      Number(params.tick_lower),
      Number(params.tick_upper),
      new BN(coinAmount),
      params.fix_amount_a,
      true,
      slippage,
      curSqrtPrice
    )

    params.amount_a = params.fix_amount_a ? params.amount_a : liquidityInput.tokenMaxA.toNumber()
    params.amount_b = params.fix_amount_a ? liquidityInput.tokenMaxB.toNumber() : params.amount_b

    return params
  }

  private static buildAddLiquidityFixTokenArgs(
    tx: TransactionBlock,
    sdk: SDK,
    params: AddLiquidityFixTokenParams,
    primaryCoinAInputs?: TransactionArgument,
    primaryCoinBInputs?: TransactionArgument
  ) {
    const typeArguments = [params.coinTypeA, params.coinTypeB]
    let functionName = 'add_liquidity_fix_coin_with_all'
    const { clmm } = sdk.sdkOptions
    const primaryCoinInputs: {
      coinInput: TransactionArgument
      coinAmount: string
    }[] = []

    if (primaryCoinAInputs) {
      primaryCoinInputs.push({
        coinInput: primaryCoinAInputs,
        coinAmount: params.amount_a.toString(),
      })
    }
    if (primaryCoinBInputs) {
      primaryCoinInputs.push({
        coinInput: primaryCoinBInputs,
        coinAmount: params.amount_b.toString(),
      })
    }
    if (!params.is_open) {
      sdk.Rewarder.collectRewarderTransactionPayload(
        {
          pool_id: params.pool_id,
          pos_id: params.pos_id,
          coinTypeA: params.coinTypeA,
          coinTypeB: params.coinTypeB,
          collect_fee: params.collect_fee,
          rewarder_coin_types: params.rewarder_coin_types,
        },
        tx
      )
    }
    const isWithAll = primaryCoinInputs.length === 2

    if (isWithAll) {
      functionName = params.is_open ? 'open_position_with_liquidity_with_all' : 'add_liquidity_fix_coin_with_all'
    } else {
      functionName = params.is_open
        ? primaryCoinAInputs !== undefined
          ? 'open_position_with_liquidity_only_a'
          : 'open_position_with_liquidity_only_b'
        : primaryCoinAInputs !== undefined
        ? 'add_liquidity_fix_coin_only_a'
        : 'add_liquidity_fix_coin_only_b'
    }

    const args = params.is_open
      ? isWithAll
        ? [
            tx.object(clmm.config.global_config_id),
            tx.object(params.pool_id),
            tx.pure(asUintN(BigInt(params.tick_lower)).toString()),
            tx.pure(asUintN(BigInt(params.tick_upper)).toString()),
            ...primaryCoinInputs.map((item) => item.coinInput),
            ...primaryCoinInputs.map((item) => tx.pure(item.coinAmount)),
            tx.pure(params.fix_amount_a),
            tx.object(CLOCK_ADDRESS),
          ]
        : [
            tx.object(clmm.config.global_config_id),
            tx.object(params.pool_id),
            tx.pure(asUintN(BigInt(params.tick_lower)).toString()),
            tx.pure(asUintN(BigInt(params.tick_upper)).toString()),
            ...primaryCoinInputs.map((item) => item.coinInput),
            ...primaryCoinInputs.map((item) => tx.pure(item.coinAmount)),
            tx.object(CLOCK_ADDRESS),
          ]
      : isWithAll
      ? [
          tx.object(clmm.config.global_config_id),
          tx.object(params.pool_id),
          tx.object(params.pos_id),
          ...primaryCoinInputs.map((item) => item.coinInput),
          ...primaryCoinInputs.map((item) => tx.pure(item.coinAmount)),
          tx.pure(params.fix_amount_a),
          tx.object(CLOCK_ADDRESS),
        ]
      : [
          tx.object(clmm.config.global_config_id),
          tx.object(params.pool_id),
          tx.object(params.pos_id),
          ...primaryCoinInputs.map((item) => item.coinInput),
          ...primaryCoinInputs.map((item) => tx.pure(item.coinAmount)),
          tx.object(CLOCK_ADDRESS),
        ]

    tx.moveCall({
      target: `${clmm.clmm_router}::${ClmmIntegratePoolModule}::${functionName}`,
      typeArguments,
      arguments: args,
    })
    return tx
  }

  // -------------------------------------swap--------------------------------------------------//
  /**
   * build add liquidity transaction
   * @param params
   * @param slippage
   * @param curSqrtPrice
   * @returns
   */
  static async buildSwapTransactionForGas(
    sdk: SDK,
    params: SwapParams,
    allCoinAsset: CoinAsset[],
    gasEstimateArg: {
      byAmountIn: boolean
      slippage: Percentage
      decimalsA: number
      decimalsB: number
      swapTicks: Array<TickData>
      currentPool: Pool
    }
  ): Promise<TransactionBlock> {
    let tx = TransactionUtil.buildSwapTransaction(sdk, params, allCoinAsset)

    const newResult = await TransactionUtil.adjustTransactionForGas(
      sdk,
      CoinAssist.getCoinAssets(params.a2b ? params.coinTypeA : params.coinTypeB, allCoinAsset),
      BigInt(params.by_amount_in ? params.amount : params.amount_limit),
      tx
    )

    const { fixAmount, fixCoinInput, newTx } = newResult

    if (fixCoinInput !== undefined && newTx !== undefined) {
      if (params.by_amount_in) {
        params.amount = fixAmount.toString()
      } else {
        params.amount_limit = fixAmount.toString()
      }
      params = TransactionUtil.fixSwapParams(sdk, params, gasEstimateArg)
      tx = TransactionUtil.buildSwapTransactionArgs(newTx, params, sdk.sdkOptions, fixCoinInput)
    }

    return tx
  }

  /**
   * build swap transaction
   * @param params
   * @param packageId
   * @returns
   */
  static buildSwapTransaction(sdk: SDK, params: SwapParams, allCoinAsset: CoinAsset[]): TransactionBlock {
    let tx = new TransactionBlock()
    const primaryCoinInputs: any = TransactionUtil.buildCoinInputForAmount(
      tx,
      allCoinAsset,
      BigInt(params.by_amount_in ? params.amount : params.amount_limit),
      params.a2b ? params.coinTypeA : params.coinTypeB
    )?.transactionArgument

    tx = TransactionUtil.buildSwapTransactionArgs(tx, params, sdk.sdkOptions, primaryCoinInputs as TransactionArgument)
    return tx
  }

  /**
   * build swap transaction
   * @param params
   * @param packageId
   * @returns
   */
  static buildSwapTransactionArgs(
    tx: TransactionBlock,
    params: SwapParams,
    sdkOptions: SdkOptions,
    primaryCoinInput: TransactionArgument
  ): TransactionBlock {
    const { clmm } = sdkOptions

    const sqrtPriceLimit = SwapUtils.getDefaultSqrtPriceLimit(params.a2b)
    const typeArguments = [params.coinTypeA, params.coinTypeB]
    const global_config_id = clmm.config?.global_config_id

    if (global_config_id === undefined) {
      throw Error('clmm.config.global_config_id is undefined')
    }

    const hasSwapPartner = params.swap_partner !== undefined

    const functionName = hasSwapPartner
      ? params.a2b
        ? 'swap_a2b_with_partner'
        : 'swap_b2a_with_partner'
      : params.a2b
      ? 'swap_a2b'
      : 'swap_b2a'

    const args = hasSwapPartner
      ? [
          tx.pure(global_config_id),
          tx.pure(params.pool_id),
          tx.pure(params.swap_partner),
          primaryCoinInput,
          tx.pure(params.by_amount_in),
          tx.pure(params.amount),
          tx.pure(params.amount_limit),
          tx.pure(sqrtPriceLimit.toString()),
          tx.pure(CLOCK_ADDRESS),
        ]
      : [
          tx.pure(global_config_id),
          tx.pure(params.pool_id),
          primaryCoinInput,
          tx.pure(params.by_amount_in),
          tx.pure(params.amount),
          tx.pure(params.amount_limit),
          tx.pure(sqrtPriceLimit.toString()),
          tx.pure(CLOCK_ADDRESS),
        ]

    tx.moveCall({
      target: `${clmm.clmm_router}::${ClmmIntegratePoolModule}::${functionName}`,
      typeArguments,
      arguments: args,
    })
    return tx
  }

  static fixSwapParams(
    sdk: SDK,
    params: SwapParams,
    gasEstimateArg: {
      byAmountIn: boolean
      slippage: Percentage
      decimalsA: number
      decimalsB: number
      swapTicks: Array<TickData>
      currentPool: Pool
    }
  ): SwapParams {
    const res = sdk.Swap.calculateRates({
      decimalsA: gasEstimateArg.decimalsA,
      decimalsB: gasEstimateArg.decimalsB,
      a2b: params.a2b,
      byAmountIn: params.by_amount_in,
      amount: new BN(params.amount),
      swapTicks: gasEstimateArg.swapTicks,
      currentPool: gasEstimateArg.currentPool,
    })

    const toAmount = gasEstimateArg.byAmountIn ? res.estimatedAmountOut : res.estimatedAmountIn

    const amountLimit = adjustForSlippage(toAmount, gasEstimateArg.slippage, !gasEstimateArg.byAmountIn)
    params.amount_limit = amountLimit.toString()
    return params
  }

  public static async syncBuildCoinInputForAmount(
    sdk: SDK,
    tx: TransactionBlock,
    amount: bigint,
    coinType: string
  ): Promise<TransactionArgument | undefined> {
    if (sdk.senderAddress.length === 0) {
      throw Error('this config sdk senderAddress is empty')
    }

    const allCoins = await sdk.getOwnerCoinAssets(sdk.senderAddress, coinType)
    const primaryCoinInput: any = TransactionUtil.buildCoinInputForAmount(tx, allCoins, amount, coinType)!.transactionArgument

    return primaryCoinInput
  }

  public static buildCoinInputForAmount(
    tx: TransactionBlock,
    allCoins: CoinAsset[],
    amount: bigint,
    coinType: string,
    buildVector = true
  ): BuildCoinInputResult | undefined {
    const coinAssets: CoinAsset[] = CoinAssist.getCoinAssets(coinType, allCoins)
    if (amount === BigInt(0)) {
      return undefined
    }
    const amountTotal = CoinAssist.calculateTotalBalance(coinAssets)
    if (amountTotal < amount) {
      throw new Error(`The amount(${amountTotal}) is Insufficient balance for ${coinType} , expect ${amount} `)
    }

    if (CoinAssist.isSuiCoin(coinType)) {
      const amountCoin = tx.splitCoins(tx.gas, [tx.pure(amount.toString())])
      if (buildVector) {
        return {
          transactionArgument: tx.makeMoveVec({ objects: [amountCoin] }),
          remainCoins: allCoins,
        }
      }
      return {
        transactionArgument: amountCoin,
        remainCoins: allCoins,
      }
    }
    const selectedCoinsResult = CoinAssist.selectCoinObjectIdGreaterThanOrEqual(coinAssets, amount)
    const coinObjectIds = selectedCoinsResult.objectArray
    if (buildVector) {
      return {
        transactionArgument: tx.makeMoveVec({ objects: coinObjectIds.map((id) => tx.object(id)) }),
        remainCoins: selectedCoinsResult.remainCoins,
      }
    }
    const [primaryCoinA, ...mergeCoinAs] = coinObjectIds
    const primaryCoinAInput: any = tx.object(primaryCoinA)

    if (mergeCoinAs.length > 0) {
      tx.mergeCoins(
        primaryCoinAInput,
        mergeCoinAs.map((coin) => tx.object(coin))
      )
    }

    return {
      transactionArgument: primaryCoinAInput,
      remainCoins: selectedCoinsResult.remainCoins,
    }
  }

  public static async calculationTxGas(sdk: JsonRpcProvider | RawSigner, tx: TransactionBlock): Promise<number> {
    const { sender } = tx.blockData

    if (sender === undefined) {
      throw Error('sender is empty')
    }

    const devResult = await sdk.devInspectTransactionBlock({
      transactionBlock: tx,
      sender,
    })
    const { gasUsed } = devResult.effects

    const estimateGas = Number(gasUsed.computationCost) + Number(gasUsed.storageCost) - Number(gasUsed.storageRebate)
    return estimateGas
  }

  static moveCallCoinZero = (txb: TransactionBlock, coinType: string) => {
    return txb.moveCall({
      target: '0x2::coin::zero',
      typeArguments: [coinType],
    })
  }

  // -------------------------------------router--------------------------------------------------//
  public static buildRouterSwapTransaction(
    sdk: SDK,
    params: SwapWithRouterParams,
    byAmountIn: boolean,
    allCoinAsset: CoinAsset[]
  ): TransactionBlock {
    const tx = new TransactionBlock()
    tx.setGasBudget(100000000)
    const { clmm } = sdk.sdkOptions

    const global_config_id = clmm.config?.global_config_id
    let coinAssets: CoinAsset[] = allCoinAsset

    for (let i = 0; i < params.paths.length; i += 1) {
      if (params.paths[i].poolAddress.length === 1) {
        const swapParams = {
          pool_id: params.paths[i].poolAddress[0],
          a2b: params.paths[i].a2b[0],
          byAmountIn,
          amount: byAmountIn ? params.paths[i].amountIn.toString() : params.paths[i].amountOut.toString(),
          amount_limit: adjustForSlippage(
            new BN(params.paths[i].rawAmountLimit[0]),
            Percentage.fromDecimal(d(params.priceSplitPoint)),
            !byAmountIn
          ).toString(),
          swap_partner: '',
          coinTypeA: params.paths[i].coinType[0],
          coinTypeB: params.paths[i].coinType[1],
        }
        const buildCoinResult = TransactionUtil.buildCoinInputForAmount(
          tx,
          coinAssets,
          BigInt(byAmountIn ? params.paths[i].amountIn.toString() : swapParams.amount_limit),
          swapParams.coinTypeA
        )
        const coin_a = buildCoinResult?.transactionArgument
        coinAssets = buildCoinResult!.remainCoins

        const functionName = swapParams.a2b ? 'swap_a2b' : 'swap_b2a'
        const sqrtPriceLimit = SwapUtils.getDefaultSqrtPriceLimit(swapParams.a2b)
        const args: any = [
          tx.object(global_config_id),
          tx.object(swapParams.pool_id),
          coin_a!,
          tx.pure(byAmountIn),
          tx.pure(swapParams.amount),
          tx.pure(swapParams.amount_limit),
          tx.pure(sqrtPriceLimit.toString()),
          tx.object(CLOCK_ADDRESS),
        ]
        const typeArguments = swapParams.a2b ? [swapParams.coinTypeA, swapParams.coinTypeB] : [swapParams.coinTypeA, swapParams.coinTypeB]
        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmIntegratePoolModule}::${functionName}`,
          typeArguments,
          arguments: args,
        })
      } else {
        const amount_0 = byAmountIn ? params.paths[i].amountIn : params.paths[i].rawAmountLimit[0]
        const amount_1 = byAmountIn ? params.paths[i].rawAmountLimit[0] : params.paths[i].amountOut

        const swapParams = {
          pool_0_id: params.paths[i].poolAddress[0],
          pool_1_id: params.paths[i].poolAddress[1],
          a2b_0: params.paths[i].a2b[0],
          a2b_1: params.paths[i].a2b[1],
          byAmountIn,
          amount_0,
          amount_1,
          amount_limit_0: adjustForSlippage(
            new BN(params.paths[i].rawAmountLimit[0]),
            Percentage.fromDecimal(d(params.priceSplitPoint)),
            !byAmountIn
          ).toString(),
          amount_limit_1: adjustForSlippage(
            new BN(params.paths[i].rawAmountLimit[1]),
            Percentage.fromDecimal(d(params.priceSplitPoint)),
            !byAmountIn
          ).toString(),
          swap_partner: '',
          coinTypeA: params.paths[i].coinType[0],
          coinTypeB: params.paths[i].coinType[1],
          coinTypeC: params.paths[i].coinType[2],
        }

        const buildCoinResult = TransactionUtil.buildCoinInputForAmount(
          tx,
          coinAssets,
          BigInt(byAmountIn ? swapParams.amount_0.toString() : swapParams.amount_limit_0),
          swapParams.coinTypeA,
          false
        )

        const coin_a = buildCoinResult?.transactionArgument
        coinAssets = buildCoinResult!.remainCoins

        const coin_c = TransactionUtil.moveCallCoinZero(tx, swapParams.coinTypeC)

        let functionName = ''
        if (swapParams.a2b_0) {
          if (swapParams.a2b_1) {
            functionName = 'swap_ab_bc'
          } else {
            functionName = 'swap_ab_cb'
          }
        } else if (swapParams.a2b_1) {
          functionName = 'swap_ba_bc'
        } else {
          functionName = 'swap_ba_cb'
        }
        const sqrtPriceLimit0 = SwapUtils.getDefaultSqrtPriceLimit(params.paths[i].a2b[0])
        const sqrtPriceLimit1 = SwapUtils.getDefaultSqrtPriceLimit(params.paths[i].a2b[1])
        const args: any = [
          tx.object(global_config_id),
          tx.object(swapParams.pool_0_id),
          tx.object(swapParams.pool_1_id),
          coin_a!,
          coin_c,
          tx.pure(byAmountIn),
          tx.pure(swapParams.amount_0.toString()),
          tx.pure(swapParams.amount_1.toString()),
          tx.pure(swapParams.amount_limit_0),
          tx.pure(swapParams.amount_limit_1),
          tx.pure(sqrtPriceLimit0.toString()),
          tx.pure(sqrtPriceLimit1.toString()),
          tx.object(CLOCK_ADDRESS),
        ]
        const typeArguments = [swapParams.coinTypeA, swapParams.coinTypeB, swapParams.coinTypeC]
        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmIntegrateRouterModule}::${functionName}`,
          typeArguments,
          arguments: args,
        })
      }
    }

    return tx
  }

  // -------------------------------------deepbook--------------------------------------------//
  public static buildRouterSwapTransactionWithDeepbook(
    sdk: SDK,
    params: SwapWithRouterParams,
    byAmountIn: boolean,
    allCoinAsset: CoinAsset[],
    accountCap: string
  ): TransactionBlock {
    // const accountCap = '0x86246e5ee123b05735077ed389f2f1920cd0e74c570990d21ac7bc1bcbb5aa23'
    const tx = new TransactionBlock()
    tx.setGasBudget(100000000)
    const { clmm, deepbook } = sdk.sdkOptions

    const global_config_id = clmm.config?.global_config_id
    let coinAssets: CoinAsset[] = allCoinAsset

    for (let i = 0; i < params.paths.length; i += 1) {
      if (params.paths[i].poolAddress.length === 1) {
        if (params.paths[i].poolType[0] === 'clmm') {
          // -------protect
          const swapParams = {
            pool_id: params.paths[i].poolAddress[0],
            a2b: params.paths[i].a2b[0],
            byAmountIn,
            amount: byAmountIn ? params.paths[i].amountIn.toString() : params.paths[i].amountOut.toString(),
            amount_limit: adjustForSlippage(
              new BN(params.paths[i].rawAmountLimit[0]),
              Percentage.fromDecimal(d(params.priceSplitPoint)),
              !byAmountIn
            ).toString(),
            swap_partner: '',
            coinTypeA: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT',
            coinTypeB: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
          }

          const coinType = swapParams.a2b ? swapParams.coinTypeA : swapParams.coinTypeB

          const buildCoinResult = TransactionUtil.buildCoinInputForAmount(
            tx,
            coinAssets,
            BigInt(byAmountIn ? params.paths[i].amountIn.toString() : swapParams.amount_limit),
            coinType
          )
          const coin_a = buildCoinResult?.transactionArgument
          coinAssets = buildCoinResult!.remainCoins

          const functionName = swapParams.a2b ? 'swap_a2b' : 'swap_b2a'
          const sqrtPriceLimit = SwapUtils.getDefaultSqrtPriceLimit(swapParams.a2b)
          const args: any = [
            tx.object(global_config_id),
            tx.object(swapParams.pool_id),
            coin_a!,
            tx.pure(byAmountIn),
            tx.pure(swapParams.amount),
            tx.pure(swapParams.amount_limit),
            tx.pure(sqrtPriceLimit.toString()),
            tx.object(CLOCK_ADDRESS),
          ]
          const typeArguments = swapParams.a2b ? [swapParams.coinTypeA, swapParams.coinTypeB] : [swapParams.coinTypeB, swapParams.coinTypeA]
          tx.moveCall({
            target: `${clmm.clmm_router}::${ClmmIntegratePoolModule}::${functionName}`,
            typeArguments,
            arguments: args,
          })
          // protect-------
        } else {
          const swapParams = {
            pool_id: params.paths[i].poolAddress[0],
            a2b: params.paths[i].a2b[0],
            byAmountIn,
            amount: byAmountIn ? params.paths[i].amountIn.toString() : params.paths[i].amountOut.toString(),
            amount_limit: adjustForSlippage(
              new BN(params.paths[i].rawAmountLimit[0]),
              Percentage.fromDecimal(d(params.priceSplitPoint)),
              !byAmountIn
            ).toString(),
            swap_partner: '',
            coinTypeA: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT',
            coinTypeB: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
          }

          const functionName = swapParams.a2b ? 'swap_exact_base_for_quote' : 'swap_exact_quote_for_base'

          if (swapParams.a2b) {
            const buildCoinResultBase = TransactionUtil.buildCoinInputForAmount(
              tx,
              coinAssets,
              BigInt(params.paths[i].amountIn.toString()),
              swapParams.coinTypeA,
              false
            )
            const baseAsset = buildCoinResultBase?.transactionArgument
            coinAssets = buildCoinResultBase!.remainCoins
            const quoteAsset = TransactionUtil.moveCallCoinZero(tx, swapParams.coinTypeB)

            const args: any = [
              tx.object(swapParams.pool_id),
              tx.pure('10'),
              tx.object(accountCap),
              tx.pure(swapParams.amount),
              baseAsset,
              quoteAsset!,
              tx.object(CLOCK_ADDRESS),
            ]

            const typeArguments = [
              '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT',
              '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
            ]
            const coins: TransactionArgument[] = tx.moveCall({
              target: `${deepbook.deepbook_display}::clob_v2::${functionName}`,
              typeArguments,
              arguments: args,
            })
            tx.transferObjects([coins[0], coins[1]], tx.object(sdk.senderAddress))
          } else {
            const buildCoinResultQuote = TransactionUtil.buildCoinInputForAmount(
              tx,
              coinAssets,
              BigInt(params.paths[i].amountIn.toString()),
              swapParams.coinTypeB
            )
            const quoteAsset = buildCoinResultQuote?.transactionArgument
            coinAssets = buildCoinResultQuote!.remainCoins

            const args: any = [
              tx.object(swapParams.pool_id),
              tx.object('10'),
              tx.pure(accountCap),
              tx.pure(swapParams.amount),
              tx.object(CLOCK_ADDRESS),
              quoteAsset!,
            ]

            const typeArguments = [
              '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdt::USDT',
              '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
            ]
            tx.moveCall({
              target: `${deepbook.deepbook_display}::clob_v2::${functionName}`,
              typeArguments,
              arguments: args,
            })
          }
        }
      } else {
        const amount_0 = byAmountIn ? params.paths[i].amountIn : params.paths[i].rawAmountLimit[0]
        const amount_1 = byAmountIn ? params.paths[i].rawAmountLimit[0] : params.paths[i].amountOut

        const swapParams = {
          pool_0_id: params.paths[i].poolAddress[0],
          pool_1_id: params.paths[i].poolAddress[1],
          a2b_0: params.paths[i].a2b[0],
          a2b_1: params.paths[i].a2b[1],
          byAmountIn,
          amount_0,
          amount_1,
          amount_limit_0: adjustForSlippage(
            new BN(params.paths[i].rawAmountLimit[0]),
            Percentage.fromDecimal(d(params.priceSplitPoint)),
            !byAmountIn
          ).toString(),
          amount_limit_1: adjustForSlippage(
            new BN(params.paths[i].rawAmountLimit[1]),
            Percentage.fromDecimal(d(params.priceSplitPoint)),
            !byAmountIn
          ).toString(),
          swap_partner: '',
          coinTypeA: params.paths[i].coinType[0],
          coinTypeB: params.paths[i].coinType[1],
          coinTypeC: params.paths[i].coinType[2],
        }

        const buildCoinResult = TransactionUtil.buildCoinInputForAmount(
          tx,
          coinAssets,
          BigInt(byAmountIn ? swapParams.amount_0.toString() : swapParams.amount_limit_0),
          swapParams.coinTypeA,
          false
        )

        const coin_a = buildCoinResult?.transactionArgument
        coinAssets = buildCoinResult!.remainCoins

        const coin_c = TransactionUtil.moveCallCoinZero(tx, swapParams.coinTypeC)

        let functionName = ''
        if (swapParams.a2b_0) {
          if (swapParams.a2b_1) {
            functionName = 'swap_ab_bc'
          } else {
            functionName = 'swap_ab_cb'
          }
        } else if (swapParams.a2b_1) {
          functionName = 'swap_ba_bc'
        } else {
          functionName = 'swap_ba_cb'
        }
        const sqrtPriceLimit0 = SwapUtils.getDefaultSqrtPriceLimit(params.paths[i].a2b[0])
        const sqrtPriceLimit1 = SwapUtils.getDefaultSqrtPriceLimit(params.paths[i].a2b[1])
        const args: any = [
          tx.object(global_config_id),
          tx.object(swapParams.pool_0_id),
          tx.object(swapParams.pool_1_id),
          coin_a!,
          coin_c,
          tx.pure(byAmountIn),
          tx.pure(swapParams.amount_0.toString()),
          tx.pure(swapParams.amount_1.toString()),
          tx.pure(swapParams.amount_limit_0),
          tx.pure(swapParams.amount_limit_1),
          tx.pure(sqrtPriceLimit0.toString()),
          tx.pure(sqrtPriceLimit1.toString()),
          tx.object(CLOCK_ADDRESS),
        ]
        const typeArguments = [swapParams.coinTypeA, swapParams.coinTypeB, swapParams.coinTypeC]
        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmIntegrateRouterModule}::${functionName}`,
          typeArguments,
          arguments: args,
        })
      }
    }

    return tx
  }

  static buildCoinTypePair(coinTypes: string[], partitionQuantities: number[]): string[][] {
    const coinTypePair: string[][] = []
    if (coinTypes.length === 2) {
      const pair: string[] = []
      pair.push(coinTypes[0], coinTypes[1])
      coinTypePair.push(pair)
    } else {
      const directPair: string[] = []
      directPair.push(coinTypes[0], coinTypes[coinTypes.length - 1])
      coinTypePair.push(directPair)
      for (let i = 1; i < coinTypes.length - 1; i += 1) {
        if (partitionQuantities[i - 1] === 0) {
          continue
        }
        const pair: string[] = []
        pair.push(coinTypes[0], coinTypes[i], coinTypes[coinTypes.length - 1])
        coinTypePair.push(pair)
      }
    }
    return coinTypePair
  }
}
