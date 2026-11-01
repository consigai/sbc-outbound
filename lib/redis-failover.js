/**
 * Follow a Valkey/Redis primary failover instead of failing every write (consigai/consig-cdk-jam#155).
 *
 * After an ElastiCache failover the demoted primary is a replica: it answers writes with
 * READONLY and, while it resyncs from the new primary, everything with LOADING. Plain Valkey
 * keeps the old connection open; ElastiCache usually drops it right after the reply. Either
 * way ioredis rejects the command, because @jambonz/realtimedb-helpers creates its clients
 * with reconnectOnError unset. On Oct 31 those rejections crashed sbc-sip-sidecar and api-server.
 *
 * Returning 2 makes ioredis drop the connection, reconnect (re-resolving the primary
 * endpoint, which now names the new primary) and resend the command. Neither error means
 * the command ran, so resending can't apply a write twice.
 *
 * ioredis reads options.reconnectOnError on every error reply, so this can be set on a
 * client that realtimedb-helpers or speech-utils has already created and connected.
 */
const FAILOVER_ERRORS = /^(READONLY|LOADING)\b/;

const reconnectOnError = (err) => (FAILOVER_ERRORS.test(err?.message || '') ? 2 : false);

function followFailover(client, logger) {
  client.options.reconnectOnError = (err) => {
    const action = reconnectOnError(err);
    if (action) {
      logger.warn({command: err.command?.name, err: err.message},
        'redis: primary changed, reconnecting and resending the command');
    }
    return action;
  };
  return client;
}

module.exports = {reconnectOnError, followFailover};
