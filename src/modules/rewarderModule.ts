import BN from 'bn.js'
import { TransactionBlock } from '@mysten/sui.js'
import { extractStructTagFromType } from '../utils'
import { ClmmFetcherModule, ClmmIntegratePoolModule, CLOCK_ADDRESS } from '../types/sui'
import { getRewardInTickRange } from '../utils/tick'
import { MathUtil, ONE, ZERO } from '../math/utils'
import { TickData } from '../types/clmmpool'
import { CetusClmmSDK } from '../sdk'
import { IModule } from '../interfaces/IModule'
import { CollectRewarderParams, Pool, Position, PositionReward, Rewarder, RewarderAmountOwed } from '../types'

export type FetchPosRewardParams = {
  poolAddress: string
  positionId: string
  coinTypeA: string
  coinTypeB: string
  rewarderInfo: Rewarder[]
}

export type PosRewarderResult = {
  poolAddress: string
  positionId: string
  rewarderAmountOwed: RewarderAmountOwed[]
}

/**
 * Helper class to help interact with clmm position rewaeder with a rewaeder router interface.
 */
export class RewarderModule implements IModule {
  protected _sdk: CetusClmmSDK

  private growthGlobal: BN[]

  constructor(sdk: CetusClmmSDK) {
    this._sdk = sdk
    this.growthGlobal = [ZERO, ZERO, ZERO]
  }

  get sdk() {
    return this._sdk
  }

  /**
   * Gets the emissions for the given pool every day.
   *
   * @param {string} poolObjectId The object ID of the pool.
   * @returns {Promise<Array<{emissions: number, coinAddress: string}>>} A promise that resolves to an array of objects with the emissions and coin address for each rewarder.
   */
  async emissionsEveryDay(poolObjectId: string) {
    const currentPool: Pool = await this.sdk.Pool.getPool(poolObjectId)
    const rewarderInfos = currentPool.rewarder_infos
    if (!rewarderInfos) {
      return null
    }

    const emissionsEveryDay = []
    for (const rewarderInfo of rewarderInfos) {
      const emissionSeconds = MathUtil.fromX64(new BN(rewarderInfo.emissions_per_second))
      emissionsEveryDay.push({
        emissions: Math.floor(emissionSeconds.toNumber() * 60 * 60 * 24),
        coin_address: rewarderInfo.coinAddress,
      })
    }

    return emissionsEveryDay
  }

  /**
   * Updates the rewarder for the given pool.
   *
   * @param {string} poolObjectId The object ID of the pool.
   * @param {BN} currentTime The current time in seconds since the Unix epoch.
   * @returns {Promise<Pool>} A promise that resolves to the updated pool.
   */
  async updatePoolRewarder(poolObjectId: string, currentTime: BN): Promise<Pool> {
    // refresh pool rewarder
    const currentPool: Pool = await this.sdk.Pool.getPool(poolObjectId)
    const lastTime = currentPool.rewarder_last_updated_time
    currentPool.rewarder_last_updated_time = currentTime.toString()

    if (Number(currentPool.liquidity) === 0 || currentTime.eq(new BN(lastTime))) {
      return currentPool
    }
    const timeDelta = currentTime.div(new BN(1000)).sub(new BN(lastTime)).add(new BN(15))
    const rewarderInfos: any = currentPool.rewarder_infos

    for (let i = 0; i < rewarderInfos.length; i += 1) {
      const rewarderInfo = rewarderInfos[i]
      const rewarderGrowthDelta = MathUtil.checkMulDivFloor(
        timeDelta,
        new BN(rewarderInfo.emissions_per_second),
        new BN(currentPool.liquidity),
        128
      )
      this.growthGlobal[i] = new BN(rewarderInfo.growth_global).add(new BN(rewarderGrowthDelta))
    }

    return currentPool
  }

  /**
   * Gets the amount owed to the rewarders for the given position.
   *
   * @param {string} poolObjectId The object ID of the pool.
   * @param {string} positionHandle The handle of the position.
   * @param {string} positionId The ID of the position.
   * @returns {Promise<Array<{amountOwed: number}>>} A promise that resolves to an array of objects with the amount owed to each rewarder.
   */
  async posRewardersAmount(poolObjectId: string, positionHandle: string, positionId: string) {
    const currentTime = Date.parse(new Date().toString())
    const pool: Pool = await this.updatePoolRewarder(poolObjectId, new BN(currentTime))
    const position = await this.sdk.Position.getPositionRewarders(positionHandle, positionId)

    if (position === undefined) {
      return []
    }

    const ticksHandle = pool.ticks_handle
    const tickLower = await this.sdk.Pool.getTickDataByIndex(ticksHandle, position.tick_lower_index)
    const tickUpper = await this.sdk.Pool.getTickDataByIndex(ticksHandle, position.tick_upper_index)

    const amountOwed = this.posRewardersAmountInternal(pool, position, tickLower, tickUpper)
    return amountOwed
  }

  /**
   * Gets the amount owed to the rewarders for the given account and pool.
   *
   * @param {string} account The account.
   * @param {string} poolObjectId The object ID of the pool.
   * @returns {Promise<Array<{amountOwed: number}>>} A promise that resolves to an array of objects with the amount owed to each rewarder.
   */
  async poolRewardersAmount(account: string, poolObjectId: string) {
    const currentTime = Date.parse(new Date().toString())
    const pool: Pool = await this.updatePoolRewarder(poolObjectId, new BN(currentTime))

    const positions = await this.sdk.Position.getPositionList(account, [poolObjectId])
    const tickDatas = await this.getPoolLowerAndUpperTicks(pool.ticks_handle, positions)

    const rewarderAmount = [ZERO, ZERO, ZERO]

    for (let i = 0; i < positions.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const posRewarderInfo: any = await this.posRewardersAmountInternal(pool, positions[i], tickDatas[0][i], tickDatas[1][i])
      for (let j = 0; j < 3; j += 1) {
        rewarderAmount[j] = rewarderAmount[j].add(posRewarderInfo[j].amount_owed)
      }
    }

    return rewarderAmount
  }

  private posRewardersAmountInternal(pool: Pool, position: PositionReward, tickLower: TickData, tickUpper: TickData): RewarderAmountOwed[] {
    const tickLowerIndex = position.tick_lower_index
    const tickUpperIndex = position.tick_upper_index
    const rewardersInside = getRewardInTickRange(pool, tickLower, tickUpper, tickLowerIndex, tickUpperIndex, this.growthGlobal)

    const growthInside = []
    const AmountOwed = []

    if (rewardersInside.length > 0) {
      let growthDelta_0 = MathUtil.subUnderflowU128(rewardersInside[0], new BN(position.reward_growth_inside_0))

      if (growthDelta_0.gt(new BN('3402823669209384634633745948738404'))) {
        growthDelta_0 = ONE
      }

      const amountOwed_0 = MathUtil.checkMulShiftRight(new BN(position.liquidity), growthDelta_0, 64, 128)
      growthInside.push(rewardersInside[0])
      AmountOwed.push({
        amount_owed: new BN(position.reward_amount_owed_0).add(amountOwed_0),

        coin_address: pool.rewarder_infos[0].coinAddress,
      })
    }

    if (rewardersInside.length > 1) {
      let growthDelta_1 = MathUtil.subUnderflowU128(rewardersInside[1], new BN(position.reward_growth_inside_1))
      if (growthDelta_1.gt(new BN('3402823669209384634633745948738404'))) {
        growthDelta_1 = ONE
      }

      const amountOwed_1 = MathUtil.checkMulShiftRight(new BN(position.liquidity), growthDelta_1, 64, 128)
      growthInside.push(rewardersInside[1])

      AmountOwed.push({
        amount_owed: new BN(position.reward_amount_owed_1).add(amountOwed_1),
        coin_address: pool.rewarder_infos[1].coinAddress,
      })
    }

    if (rewardersInside.length > 2) {
      let growthDelta_2 = MathUtil.subUnderflowU128(rewardersInside[2], new BN(position.reward_growth_inside_2))
      if (growthDelta_2.gt(new BN('3402823669209384634633745948738404'))) {
        growthDelta_2 = ONE
      }

      const amountOwed_2 = MathUtil.checkMulShiftRight(new BN(position.liquidity), growthDelta_2, 64, 128)
      growthInside.push(rewardersInside[2])

      AmountOwed.push({
        amount_owed: new BN(position.reward_amount_owed_2).add(amountOwed_2),
        coin_address: pool.rewarder_infos[2].coinAddress,
      })
    }
    return AmountOwed
  }

  /**
   * Fetches the Position reward amount for a given list of addresses.
   * @param params  An array of FetchPosRewardParams objects containing the target addresses and their corresponding amounts.
   * @returns
   */
  async fetchPosRewardersAmount(params: FetchPosRewardParams[]) {
    const { clmm, simulationAccount } = this.sdk.sdkOptions
    const tx = new TransactionBlock()

    for (const paramItem of params) {
      const typeArguments = [paramItem.coinTypeA, paramItem.coinTypeB]
      const args = [
        tx.object(clmm.config.global_config_id),
        tx.object(paramItem.poolAddress),
        tx.pure(paramItem.positionId),
        tx.object(CLOCK_ADDRESS),
      ]
      tx.moveCall({
        target: `${clmm.clmm_router}::${ClmmFetcherModule}::fetch_position_rewards`,
        arguments: args,
        typeArguments,
      })
    }

    const simulateRes = await this.sdk.fullClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: simulationAccount.address,
    })

    const valueData: any = simulateRes.events?.filter((item: any) => {
      return extractStructTagFromType(item.type).name === `FetchPositionRewardsEvent`
    })
    if (valueData.length === 0) {
      return null
    }

    if (valueData.length !== params.length) {
      throw new Error('valueData.length !== params.pools.length')
    }

    const result: PosRewarderResult[] = []

    for (let i = 0; i < valueData.length; i += 1) {
      const posRrewarderResult: PosRewarderResult = {
        poolAddress: params[i].poolAddress,
        positionId: params[i].positionId,
        rewarderAmountOwed: [],
      }

      for (let j = 0; j < params[i].rewarderInfo.length; j += 1) {
        posRrewarderResult.rewarderAmountOwed.push({
          amount_owed: new BN(valueData[i].parsedJson.data[j]),
          coin_address: params[i].rewarderInfo[j].coinAddress,
        })
      }

      result.push(posRrewarderResult)
    }

    return result
  }

  /**
   * Fetches the pool reward amount for a given account and pool object id.
   * @param {string} account - The target account.
   * @param {string} poolObjectId - The target pool object id.
   * @returns {Promise<number|null>} - A Promise that resolves with the fetched pool reward amount for the specified account and pool, or null if the fetch is unsuccessful.
   */
  async fetchPoolRewardersAmount(account: string, poolObjectId: string) {
    const pool: Pool = await this.sdk.Pool.getPool(poolObjectId)
    const positions = await this.sdk.Position.getPositionList(account, [poolObjectId])

    const params: FetchPosRewardParams[] = []

    for (const position of positions) {
      params.push({
        poolAddress: pool.poolAddress,
        positionId: position.pos_object_id,
        rewarderInfo: pool.rewarder_infos,
        coinTypeA: pool.coinTypeA,
        coinTypeB: pool.coinTypeB,
      })
    }

    const result = await this.fetchPosRewardersAmount(params)

    const rewarderAmount = [ZERO, ZERO, ZERO]

    if (result != null) {
      for (const posRewarderInfo of result) {
        for (let j = 0; j < posRewarderInfo.rewarderAmountOwed.length; j += 1) {
          rewarderAmount[j] = rewarderAmount[j].add(posRewarderInfo.rewarderAmountOwed[j].amount_owed)
        }
      }
    }
    return rewarderAmount
  }

  private async getPoolLowerAndUpperTicks(ticksHandle: string, positions: Position[]): Promise<TickData[][]> {
    const lowerTicks: TickData[] = []
    const upperTicks: TickData[] = []

    for (const pos of positions) {
      const tickLower = await this.sdk.Pool.getTickDataByIndex(ticksHandle, pos.tick_lower_index)
      const tickUpper = await this.sdk.Pool.getTickDataByIndex(ticksHandle, pos.tick_upper_index)
      lowerTicks.push(tickLower)
      upperTicks.push(tickUpper)
    }

    return [lowerTicks, upperTicks]
  }

  /**
   * Collect rewards from Position.
   * @param params
   * @param gasBudget
   * @returns
   */
  collectRewarderTransactionPayload(params: CollectRewarderParams, tx?: TransactionBlock): TransactionBlock {
    const { clmm } = this.sdk.sdkOptions

    const typeArguments = [params.coinTypeA, params.coinTypeB]

    tx = tx === undefined ? new TransactionBlock() : tx

    if (params.collect_fee) {
      this._sdk.Position.collectFeeTransactionPayload(
        {
          pool_id: params.pool_id,
          pos_id: params.pos_id,
          coinTypeA: params.coinTypeA,
          coinTypeB: params.coinTypeB,
        },
        tx
      )
    }
    params.rewarder_coin_types.forEach((type) => {
      if (tx) {
        tx.moveCall({
          target: `${clmm.clmm_router}::${ClmmIntegratePoolModule}::collect_reward`,
          typeArguments: [...typeArguments, type],
          arguments: [
            tx.object(clmm.config.global_config_id),
            tx.object(params.pool_id),
            tx.object(params.pos_id),
            tx.object(clmm.config.global_vault_id),
            tx.object(CLOCK_ADDRESS),
          ],
        })
      }
    })

    return tx
  }
}
