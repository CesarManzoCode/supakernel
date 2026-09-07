import { openNodeSqlite } from '@supakernel/db-sqlite/node'
import { describeCrud } from './crud-scenarios.js'

describeCrud('sqlite', () => openNodeSqlite({ path: ':memory:' }))
