const mockRouter = {
  get: jest.fn()
}

jest.mock('express', () => ({
  Router: () => mockRouter
}), { virtual: true })

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/requestDetailService', () => ({
  listRequestDetails: jest.fn(),
  getRequestDetail: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  start: jest.fn()
}))

const requestDetailService = require('../src/services/requestDetailService')
require('../src/routes/admin/requestDetails')

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }
  return res
}

describe('requestDetails admin routes', () => {
  beforeEach(() => {
    requestDetailService.listRequestDetails.mockReset()
    requestDetailService.getRequestDetail.mockReset()
  })

  test('returns 400 for invalid request detail queries', async () => {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    requestDetailService.listRequestDetails.mockRejectedValue(error)

    const [, , handler] = mockRouter.get.mock.calls[0]
    const res = createResponse()

    await handler({ query: { startDate: 'bad' } }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.success).toBe(false)
    expect(res.body.message).toBe('Invalid date range')
  })

  test('returns retained detail records even when capture is disabled', async () => {
    requestDetailService.getRequestDetail.mockResolvedValue({
      captureEnabled: false,
      retentionDays: 7,
      record: {
        requestId: 'req_1',
        model: 'gpt-5.4'
      }
    })

    const [, , handler] = mockRouter.get.mock.calls[1]
    const res = createResponse()

    await handler({ params: { requestId: 'req_1' } }, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.body.success).toBe(true)
    expect(res.body.data.captureEnabled).toBe(false)
    expect(res.body.data.record.requestId).toBe('req_1')
  })
})
