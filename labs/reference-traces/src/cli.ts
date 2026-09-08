// `trace:audit` entrypoint.
import { auditAll, formatReport } from './audit.js'

const report = auditAll()
console.log(formatReport(report))
process.exit(report.ok ? 0 : 1)
