const Promise = require('bluebird');
const redis = Promise.promisifyAll(require('redis'));
const DatabaseUtil = require('./DatabaseUtil');

class DatabaseClient {
  /**
   * @constructor
   * @param {string} namespace - Namespace to prefix all keys in the database.
   * @param {Number} cacheTtl - Number of seconds before database entries expire.
   * @param {RedisClient} redisClient - Redis database initialized client.
   */
  constructor(namespace, cacheTtl, redisClient) {
    this.namespace = namespace;
    this.redisClient = redisClient;
    this.blockNumberKey = this.addNamespace('block');
    this.transfersKey = this.addNamespace('transfers');
    this.cacheTtl = cacheTtl;
  }

  /**
   * Returns a promise resolving to an initialized DatabaseClient.
   * @param {string} namespace - Namespace to prefix all keys in the database.
   * @param {Number} cacheTtl - Number of seconds before database entries expire.
   * @returns {Promise}
   */
  static create(namespace, cacheTtl) {
    return new Promise((resolve, reject) => {
      const redisClient = redis.createClient();
      redisClient.on('ready', () => {
        resolve(new DatabaseClient(namespace, cacheTtl, redisClient));
      });
      redisClient.on('error', reject);
    });
  }

  /**
   * Retrieves height of pending block.
   * @returns {Number}
   */
  async getPendingBlockNumber() {
    const blockNumber = await this.redisClient.getAsync(this.blockNumberKey);
    return blockNumber !== null ? Number(blockNumber) : null;
  }

  /**
   * Sets the pending block's height to blockNumber.
   * @param {Number} blockNumber
   */
  async setPendingBlockNumber(blockNumber) {
    await this.redisClient.setexAsync(this.blockNumberKey, this.cacheTtl, blockNumber);
  }

  /**
   * Adds transfer to queue of token transfers ready for publishing if it
   * has never been added before.
   * @param {Object} transfer
   */
  async addTransfer(transfer) {
    const transferKey = this.makeTransferKey(transfer);
    const exists = await this.redisClient.existsAsync(transferKey) === 1;
    if (!exists) {
      const fields = DatabaseUtil.flatten(Object.entries(transfer));
      const transferId = DatabaseUtil.getTransferId(transfer);
      await this.redisClient.multi()
        .hmset(transferKey, ...fields)
        .expire(transferKey, this.cacheTtl)
        .zadd(this.transfersKey, 0, DatabaseUtil.encodeTransferId(transferId))
        .expire(this.transfersKey, this.cacheTtl)
        .execAsync();
    }
  }

  /**
   * Retrieves the next token transfer ready for publishing. Always the lowest
   * transfer in terms of event order is returned. It does not remove the transfer
   * from the queue.
   * @returns {Object}
   */
  async nextTransfer() {
    const range = await this.redisClient.zrangebyscoreAsync(this.transfersKey, ...[
      0, 0, 'LIMIT', 0, 1,
    ]);
    if (range.length === 0) {
      return null;
    }
    const transferId = DatabaseUtil.decodeTransferId(range[0]);
    const transferKey = this.makeTransferKeyFromId(transferId);
    const { blockNumber, logIndex, transactionHash, from, to, value, unit } =
      await this.redisClient.hgetallAsync(transferKey);
    return {
      blockNumber: Number(blockNumber),
      logIndex: Number(logIndex),
      transactionHash,
      from,
      to,
      value,
      unit,
    };
  }

  /**
   * Remove the given transfer from the publishing queue.
   * @param {Object} transfer
   */
  async removeTransfer(transfer) {
    const transferId = DatabaseUtil.getTransferId(transfer);
    await this.redisClient.zremAsync(
      this.transfersKey,
      DatabaseUtil.encodeTransferId(transferId),
    );
  }

  makeTransferKeyFromId(transferId) {
    const baseKey = [
      'tx',
      transferId,
    ].join(DatabaseUtil.keySeparator());
    return this.addNamespace(baseKey);
  }

  makeTransferKey(transfer) {
    return this.makeTransferKeyFromId(DatabaseUtil.getTransferId(transfer));
  }

  addNamespace(baseKey) {
    return [
      this.namespace,
      baseKey,
    ].join(DatabaseUtil.keySeparator());
  }
}

module.exports = DatabaseClient;
