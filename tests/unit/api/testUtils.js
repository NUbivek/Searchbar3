function createMockReq(overrides = {}) {
  return {
    method: 'GET',
    query: {},
    body: {},
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return res;
}

module.exports = {
  createMockReq,
  createMockRes,
};
