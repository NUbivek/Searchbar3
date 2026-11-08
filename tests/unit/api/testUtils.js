function createMockReq(overrides = {}) {
  return {
    method: 'GET',
    query: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };

  return res;
}

module.exports = {
  createMockReq,
  createMockRes,
};
