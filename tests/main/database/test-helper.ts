import { Database } from '../../../src/main/database/database'

export async function createTestDb(): Promise<Database> {
  const db = new Database(':memory:')
  await db.init()
  return db
}

export function destroyTestDb(db: Database): void {
  db.close()
}
