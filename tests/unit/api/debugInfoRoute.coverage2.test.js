import handler from '../../../src/pages/api/debug-info';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('/api/debug-info', () => {
  it('returns normalized debug metadata', () => {
    const req = {
      method: 'POST',
      headers: {
        'x-test-header': 'debug'
      }
    };
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeTruthy();
    expect(res.body.status).toBe('ok');
    expect(res.body.method).toBe('POST');
    expect(res.body.headers).toEqual(req.headers);
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body).toHaveProperty('env');
  });
});
