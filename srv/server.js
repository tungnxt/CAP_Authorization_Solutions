const cds = require('@sap/cds')
const enrichUser = require('./lib/enrich-user')

// SAU auth() — cần u.id đã xác thực.
// TRƯỚC dispatch — @requires/@restrict phải thấy req.user đã được nạp.
cds.middlewares.add(enrichUser(), { after: 'auth' })

module.exports = cds.server
