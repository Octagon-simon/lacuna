import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMockCallMismatchHint, buildMockLeakageHint } from './mock-call-hints.js'

// Real text (verbatim, hand-verified earlier this session against the real repo class) captured
// from a production project's adminUsers.interactor.ts / adminUsers.interactor.test.ts, BEFORE
// the fix: the source calls `.findOneAndDelete()`, but the test's mock only ever provided
// `deleteMany` — a method that doesn't exist on the real SecurityQuestionsRepo class at all.
const REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE = `
  async resetSecurityQuestions(admin: AuthenticatedAdmin, userId: string) {
    const userAccount = createUserAccountInteractor(new mongoose.Types.ObjectId(userId));
    const userInfo = await userAccount.getData();
    if (!userInfo) {
      throw new DomainError("USER_NOT_FOUND", "User Information was not found", 400);
    }
    const [updateRecord, deleteRecord] = await Promise.all([
      createUserAccountRepo().updateById(userId, { $set: { hasSetupSecurityQuestions: false } }),
      createSecurityQuestionsRepo().findOneAndDelete(userId),
    ]);
  }
`

const REAL_TEST_MOCKING_DELETE_MANY_INSTEAD = `
    it("resets security questions successfully", async () => {
      const mockSecurityQuestionsRepo = {
        deleteMany: (jest.fn() as unknown as jest.Mock<() => Promise<any>>).mockResolvedValue({ deletedCount: 2 }),
      };
      mockCreateSecurityQuestionsRepo.mockReturnValue(mockSecurityQuestionsRepo as never);
    });
`

const REAL_TEST_MOCKING_CORRECT_METHOD = `
    it("resets security questions successfully", async () => {
      const mockUserAccountRepo = {
        updateById: (jest.fn() as unknown as jest.Mock<() => Promise<any>>).mockResolvedValue({ _id: userId }),
      };
      mockCreateUserAccountRepo.mockReturnValue(mockUserAccountRepo as never);

      const mockSecurityQuestionsRepo = {
        findOneAndDelete: (jest.fn() as unknown as jest.Mock<() => Promise<any>>).mockResolvedValue({ _id: userId }),
      };
      mockCreateSecurityQuestionsRepo.mockReturnValue(mockSecurityQuestionsRepo as never);
    });
`

test('buildMockCallMismatchHint fires on the real captured findOneAndDelete/deleteMany mismatch', () => {
  const hint = buildMockCallMismatchHint(REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE, REAL_TEST_MOCKING_DELETE_MANY_INSTEAD, null)
  assert.ok(hint, 'expected a mismatch hint')
  assert.match(hint!, /MOCK\/SOURCE METHOD MISMATCH/)
  assert.match(hint!, /createSecurityQuestionsRepo/)
  assert.match(hint!, /findOneAndDelete/)
})

test('buildMockCallMismatchHint does not fire once the mock provides the correct method', () => {
  const hint = buildMockCallMismatchHint(REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE, REAL_TEST_MOCKING_CORRECT_METHOD, null)
  assert.equal(hint, null)
})

test('buildMockCallMismatchHint returns null when sourceCode or testCode is missing', () => {
  assert.equal(buildMockCallMismatchHint(null, REAL_TEST_MOCKING_DELETE_MANY_INSTEAD, null), null)
  assert.equal(buildMockCallMismatchHint(REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE, null, null), null)
})

test('buildMockCallMismatchHint gates on errorOutput shape when provided (fix mode)', () => {
  // A missing-field-shaped error should still allow the hint through...
  const missingFieldError = "TypeError: Cannot read properties of undefined (reading 'findOneAndDelete')"
  const hintShown = buildMockCallMismatchHint(REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE, REAL_TEST_MOCKING_DELETE_MANY_INSTEAD, missingFieldError)
  assert.ok(hintShown)
  // ...but an unrelated assertion-shaped error should not pull in this hint (avoid pollution).
  const unrelatedError = 'expect(received).toBe(expected)\n\nExpected: true\nReceived: false'
  const hintHidden = buildMockCallMismatchHint(REAL_SOURCE_CALLING_FIND_ONE_AND_DELETE, REAL_TEST_MOCKING_DELETE_MANY_INSTEAD, unrelatedError)
  assert.equal(hintHidden, null)
})

// Illustrative (not a literal capture) — mirrors the exact pattern independently reported by the
// dogfooding agents: jest.clearAllMocks() is used (which does NOT clear a prior
// mockResolvedValue), beforeEach restores SOME mocks but misses mockGetCurrencyByCountryName
// entirely, and one test's override of it is never reset — the real sendMoney bug restored 7
// mocks correctly and missed exactly 4 in exactly this shape.
const LEAKAGE_TEST_CODE = `
describe('sendMoney', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetParameter.mockResolvedValue('10000');
  });

  it('handles a currency mismatch', () => {
    mockGetCurrencyByCountryName.mockReturnValue('GHS');
  });

  it('handles the default currency case', () => {
    expect(mockGetCurrencyByCountryName()).toBe('NGN');
  });
});
`

test('buildMockLeakageHint fires when a mock override is never restored in beforeEach', () => {
  const hint = buildMockLeakageHint(LEAKAGE_TEST_CODE)
  assert.ok(hint, 'expected a leakage hint')
  assert.match(hint!, /MOCK STATE LEAKAGE RISK/)
})

test('buildMockLeakageHint does not fire when resetAllMocks is used instead of clearAllMocks', () => {
  const safe = LEAKAGE_TEST_CODE.replace('jest.clearAllMocks();', 'jest.resetAllMocks();')
  assert.equal(buildMockLeakageHint(safe), null)
})

test('buildMockLeakageHint does not fire when the override IS restored in beforeEach', () => {
  const restored = `
describe('sendMoney', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrencyByCountryName.mockReturnValue('NGN');
  });

  it('handles a currency mismatch', () => {
    mockGetCurrencyByCountryName.mockReturnValueOnce('GHS');
  });
});
`
  assert.equal(buildMockLeakageHint(restored), null)
})

test('buildMockLeakageHint returns null for a missing/empty test file', () => {
  assert.equal(buildMockLeakageHint(null), null)
  assert.equal(buildMockLeakageHint(''), null)
})
