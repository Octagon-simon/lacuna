import { describe, it, expect } from 'vitest'
import * as math from '../math'

describe('math', () => {
  it('adds two numbers', () => {
    expect(math.add(2, 3)).toBe(5)
  })

  it('subtracts numbers', () => {
    expect(math.subtract(10, 4)).toBe(6)
  })

  it('clamps a value within range', () => {
    expect(math.clamp(15, 0, 10)).toBe(10)
  })

  it('throws when min > max', () => {
    expect(() => math.clamp(5, 10, 0)).toThrow('min must be <= max')
  })
})