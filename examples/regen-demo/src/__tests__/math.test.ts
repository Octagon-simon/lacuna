import { add } from '../math'

describe('Math functions', () => {
  it('should run the add function without throwing', () => {
    expect(() => add(1, 2)).not.toThrow()
  })
})