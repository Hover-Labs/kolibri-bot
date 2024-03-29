const _ = require('lodash')
const winston = require('winston')
const { CONTRACTS, Network, StableCoinClient } = require('@hover-labs/kolibri-js')

const formatters = require("./formatters")
const web = require("./web")

const Sentry = require("@sentry/node")
Sentry.init({
  dsn: "https://1f54507f83d846f5a56402a97337b8c8@o68511.ingest.sentry.io/5643672",
})

require('dotenv').config()

const WATCH_TIMEOUT = 15 * 60 * 1000 // Check contracts every 15 mins
const DISCORD_WEBHOOK_TESTNET = process.env.DISCORD_WEBHOOK_TESTNET
const DISCORD_WEBHOOK_MAINNET = process.env.DISCORD_WEBHOOK_MAINNET

if (DISCORD_WEBHOOK_TESTNET === undefined || DISCORD_WEBHOOK_MAINNET === undefined){
  throw new Error("Must set DISCORD_WEBHOOK_TESTNET and DISCORD_WEBHOOK_MAINNET!")
}

const betterCallDevAxios = web.getLimitingAxios(2, 100)
const discordAxios = web.getLimitingAxios(1, 250)

const logger = winston.createLogger({
  level: 'debug',
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
      )
    })
  ],
})

const stableCoinClientTestnet = new StableCoinClient(
    'https://rpctest.tzbeta.net',
    Network.Florence,
    CONTRACTS.TEST.OVEN_REGISTRY,
    CONTRACTS.TEST.MINTER,
    CONTRACTS.TEST.OVEN_FACTORY,
)

const stableCoinClientMainnet = new StableCoinClient(
    'https://rpc.tzbeta.net',
    Network.Mainnet,
    CONTRACTS.MAIN.OVEN_REGISTRY,
    CONTRACTS.MAIN.MINTER,
    CONTRACTS.MAIN.OVEN_FACTORY,
)

const CONTRACT_TYPES = Object.freeze({
  OvenFactory: 1,
  Oven: 2,
})

const OPERATION_HANDLER_MAP = Object.freeze({
  [CONTRACT_TYPES.OvenFactory]: formatters.ovenFactoryOperationMessage,
  [CONTRACT_TYPES.Oven]: formatters.ovenOperationMessage,
})

logger.info("Starting Kolibri-bot!")

// Kick off mainnet factory watcher first, then watch all mainnet ovens
watchContract(Network.Mainnet, CONTRACTS.MAIN.OVEN_FACTORY, CONTRACT_TYPES.OvenFactory, WATCH_TIMEOUT, null)
    .then(async () => {
      const ovens = await stableCoinClientMainnet.getAllOvens()
      for (const {ovenAddress} of ovens) {
        // Sleep for 250ms to prevent thundering herd issues
        await new Promise(resolve => setTimeout(resolve, 250))

        await watchContract(Network.Mainnet, ovenAddress, CONTRACT_TYPES.Oven, WATCH_TIMEOUT, null)
      }
    })

// Kick off testnet factory watcher first, then watch all testnet ovens
watchContract(Network.Florence, CONTRACTS.TEST.OVEN_FACTORY, CONTRACT_TYPES.OvenFactory, WATCH_TIMEOUT, null)
    .then(async () => {
      const ovens = await stableCoinClientTestnet.getAllOvens()

      for (const {ovenAddress} of ovens) {
        // Sleep for 250ms to prevent thundering herd issues
        await new Promise(resolve => setTimeout(resolve, 250))
        await watchContract(Network.Florence, ovenAddress, CONTRACT_TYPES.Oven, WATCH_TIMEOUT, null)
      }
    })

async function watchContract(network, contractAddress, type, timeout, state) {
  const params = state === null ?
      "status=applied" :
      `status=applied&from=${state.latestOpTimestamp + 1000}` // +1s as the check server-side is >= so we include the last tx without it

  logger.info("Fetching contract data", {network, contractAddress, state, params})

  const response = await betterCallDevAxios.get(`https://api.better-call.dev/v1/contract/${network}/${contractAddress}/operations?${params}`)

  const operations = _(response.data.operations).filter(op => op.internal === false).value().reverse()

  if (operations.length !== 0) {
    const latestOp = _(operations).orderBy('timestamp', 'desc').first()

    // Find and assign ovenOwner to contracts via state on first pass.
    if (state === null){
      // We do not want to assign an ovenOwner for the Oven Factory
      if (type !== CONTRACT_TYPES.OvenFactory) {
        let ovenOwner
        const makeOvenOperation = operations.find(o => o.entrypoint === 'makeOven')
        // If we did not receive the makeOven call in our set of operations
        // then make an explicit call to the store of that contract for ovenOwner
        if (makeOvenOperation === undefined) {
          const storageResponse = await betterCallDevAxios.get(`https://api.better-call.dev/v1/contract/${network}/${contractAddress}/storage`)
          ovenOwner = storageResponse.data[0].children.filter(o => o.name === "owner").value
        } else {
          ovenOwner = makeOvenOperation.source
        }
        state = { ovenOwner }
      } else {
        state = {}
      }
    } else {
      // Do notification things here
      logger.info("New operations found!", {network, contractAddress, operations: operations.length})

      for (const operation of operations) {
        // Skip duplicate origination notification on Oven contracts (should never actually happen)
        if (operation.entrypoint === 'makeOven' && type === CONTRACT_TYPES.Oven) { continue }
        // Ignore calls to default entrypoint if it is not made by the originator of the oven (likely baker sending rewards)
        if (operation.entrypoint === "default" && state.ovenOwner !== operation.source) { continue }

        await processNewOperation(operation, type)
      }
    }

    state.latestOpTimestamp = new Date(latestOp.timestamp).getTime()
  } else {
    logger.debug("No new operations!", network, contractAddress)
  }

  setTimeout(watchContract.bind(null, network, contractAddress, type, timeout, state), timeout)
}

async function processNewOperation(operation, contractType){
  logger.info("New operation found!")
  logger.info(OPERATION_HANDLER_MAP[contractType](operation))
  if (operation.network === 'mainnet'){
    await discordAxios.post(DISCORD_WEBHOOK_MAINNET, {
      content: OPERATION_HANDLER_MAP[contractType](operation)
    })
  } else {
    await discordAxios.post(DISCORD_WEBHOOK_TESTNET, {
      content: OPERATION_HANDLER_MAP[contractType](operation)
    })
  }

  // If we have a `makeOven` call, we need to add a watcher for the new oven
  if (contractType === CONTRACT_TYPES.OvenFactory && operation.entrypoint === 'makeOven'){
    logger.info("makeOven called, adding it to the pool!")
    const result = await betterCallDevAxios.get('https://api.better-call.dev/v1/opg/' + operation.hash)

    let newlyCreatedContract = result.data.find(o => o.kind === 'origination').destination
    logger.info("Found newly created contract!", {newlyCreatedContract, network: operation.network})

    await watchContract(
        operation.network,
        newlyCreatedContract,
        CONTRACT_TYPES.Oven,
        WATCH_TIMEOUT,
        null
    )
  }
}
