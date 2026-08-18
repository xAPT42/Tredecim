/**
 * Sizing that has to be in place before lib/db builds its pool.
 *
 * ES module bodies run in import order, so importing this first is what makes the setting
 * take effect, assigning it inside main() would run after the pool already exists.
 *
 * Batch scripts drive far more concurrency than a serverless request does, and assertFact
 * holds its connection while waiting on FOR UPDATE. With the production-sized default the
 * surplus writers time out waiting for a connection, which reads exactly like database
 * contention and is nothing of the sort.
 */
process.env.PG_POOL_MAX ??= '20'
