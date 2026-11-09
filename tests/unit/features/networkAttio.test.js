/**
 * Attio import: people records become contacts, direct vs firm-wide decided
 * by the strongest-connection workspace member; the route never stores the
 * token and labels everything firm-wide when members cannot be read.
 */
jest.mock('../../../src/server/auth', () => ({ getUserId: jest.fn(async () => 'user-1'), requireUser: jest.fn(async () => 'user-1'), getUserEmail: jest.fn(async () => 'me@firm.com') }));
jest.mock('../../../src/server/network/store', () => ({
  replaceContacts: jest.fn(async (userId, source, contacts) => ({ saved: contacts.length, duplicates: 0, truncated: false, contacts })),
  contactStats: jest.fn(async () => ({ total: 0 })),
  MAX_CONTACTS_PER_USER: 30000,
}));

const { mapPerson } = require('../../../src/pages/api/network/attio');
const handler = require('../../../src/pages/api/network/attio').default;
const store = require('../../../src/server/network/store');

const person = (over = {}) => ({
  id: { record_id: 'p1' },
  created_at: '2025-03-04T10:00:00Z',
  values: {
    name: [{ first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' }],
    email_addresses: [{ email_address: 'ada@acme.com' }],
    job_title: [{ value: 'CTO' }],
    company: [{ target_object: 'companies', target_record_id: 'c1' }],
    primary_location: [{ locality: 'London', region: null, country_code: 'GB' }],
    linkedin: [{ value: 'https://www.linkedin.com/in/ada' }],
    strongest_connection_user: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: 'm2' }],
    strongest_connection_strength: [{ option: { title: 'Strong' } }],
    ...over,
  },
});
const ctx = () => ({
  companies: new Map([['c1', 'Acme Robotics']]),
  members: new Map([['m1', { first_name: 'Me', last_name: 'Partner', email: 'me@firm.com' }], ['m2', { first_name: 'Col', last_name: 'League', email: 'col@firm.com' }]]),
  myMemberId: 'm1',
});

describe('mapPerson', () => {
  test('maps fields and marks a colleague-held contact as firm-wide with the colleague named', () => {
    expect(mapPerson(person(), ctx())).toEqual(expect.objectContaining({
      name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', company: 'Acme Robotics', position: 'CTO',
      email: 'ada@acme.com', location: 'London, GB', profileUrl: 'https://www.linkedin.com/in/ada', connectedOn: '2025-03-04',
      relationship: 'firm', via: 'Col League', tags: ['Attio: Strong'],
    }));
  });
  test('my own strongest connection is direct, with no via', () => {
    const p = person({ strongest_connection_user: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: 'm1' }] });
    expect(mapPerson(p, ctx())).toEqual(expect.objectContaining({ relationship: 'direct', via: '' }));
  });
  test('no strongest connection, or no member list, is firm-wide; no name is dropped', () => {
    expect(mapPerson(person({ strongest_connection_user: [] }), ctx())).toMatchObject({ relationship: 'firm', via: '' });
    expect(mapPerson(person(), { companies: new Map(), members: new Map(), myMemberId: '' })).toMatchObject({ relationship: 'firm', company: '' });
    expect(mapPerson(person({ name: [] }), ctx())).toBeNull();
  });
});

describe('POST /api/network/attio', () => {
  const call = (body) => {
    const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    return handler({ method: 'POST', body, headers: {} }, res).then(() => res);
  };

  beforeEach(() => { store.replaceContacts.mockClear(); });

  test('requires a token', async () => {
    const res = await call({});
    expect(res.statusCode).toBe(400);
  });

  test('imports people, splits direct from firm, and never echoes the token', async () => {
    global.fetch = jest.fn(async (url, opts) => {
      const text = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
      if (String(url).endsWith('/workspace_members')) return text({ data: [{ id: { workspace_member_id: 'm1' }, first_name: 'Me', last_name: 'P', email_address: 'me@firm.com' }, { id: { workspace_member_id: 'm2' }, first_name: 'Col', last_name: 'L', email_address: 'col@firm.com' }] });
      if (String(url).includes('/objects/companies/')) return text({ data: [{ id: { record_id: 'c1' }, values: { name: [{ value: 'Acme Robotics' }] } }] });
      if (String(url).includes('/objects/people/')) {
        expect(opts.headers.Authorization).toBe('Bearer secret-token');
        return text({ data: [person(), { ...person(), id: { record_id: 'p2' }, values: { ...person().values, name: [{ full_name: 'Bob Builder' }], email_addresses: [{ email_address: 'bob@x.com' }], linkedin: [], strongest_connection_user: [{ referenced_actor_id: 'm1' }] } }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await call({ token: 'secret-token' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ saved: 2, direct: 1, firm: 1, companies: 1, members: 2 });
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    expect(store.replaceContacts).toHaveBeenCalledWith('user-1', 'attio', expect.arrayContaining([expect.objectContaining({ name: 'Bob Builder', relationship: 'direct' })]));
  });

  test('a token that cannot read members still imports, all firm-wide, with a note', async () => {
    global.fetch = jest.fn(async (url) => {
      const text = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
      if (String(url).endsWith('/workspace_members')) return text({ message: 'forbidden' }, 403);
      if (String(url).includes('/objects/companies/')) return text({ data: [] });
      return text({ data: [person()] });
    });
    const res = await call({ token: 'tok' });
    expect(res.body).toMatchObject({ saved: 1, direct: 0, firm: 1 });
    expect(res.body.note).toMatch(/firm-wide/);
  });

  test('a rejected token is reported as such', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' }));
    const res = await call({ token: 'bad' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/rejected/);
  });
});
