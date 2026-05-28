import { add, subtract, multiply, divide, clamp, average } from '../math'

describe('math', () => {
  describe('add', () => {
    it('adds two positive numbers', () => {
      expect(add(2, 3)).toBe(5)
    })

    it('adds negative numbers', () => {
      expect(add(-1, -2)).toBe(-3)
    })
  })

  describe('subtract', () => {
    it('subtracts two numbers', () => {
      expect(subtract(5, 3)).toBe(2)
    })

    it('subtracts resulting in negative', () => {
      expect(subtract(3, 5)).toBe(-2)
    })
  })

  describe('multiply', () => {
    it('multiplies two positive numbers', () => {
      expect(multiply(4, 3)).toBe(12)
    })

    it('multiplies by zero', () => {
      expect(multiply(5, 0)).toBe(0)
    })

    it('multiplies negative numbers', () => {
      expect(multiply(-2, -3)).toBe(6)
    })

    it('multiplies positive and negative', () => {
      expect(multiply(4, -2)).toBe(-8)
    })
  })

  describe('divide', () => {
    it('divides two positive numbers', () => {
      expect(divide(10, 2)).toBe(5)
    })

    it('divides resulting in decimal', () => {
      expect(divide(7, 2)).toBe(3.5)
    })

    it('divides negative numbers', () => {
      expect(divide(-6, -3)).toBe(2)
    })

    it('throws on division by zero', () => {
      expect(() => divide(5, 0)).toThrow('Division by zero')
    })
  })

  describe('clamp', () => {
    it('clamps value below range', () => {
      expect(clamp(-5, 0, 10)).toBe(0)
    })

    it('clamps value above range', () => {
      expect(clamp(15, 0, 10)).toBe(10)
    })

    it('returns value within range', () => {
      expect(clamp(5, 0, 10)).toBe(5)
    })

    it('handles value equal to min', () => {
      expect(clamp(0, 0, 10)).toBe(0)
    })

    it('handles value equal to max', () => {
      expect(clamp(10, 0, 10)).toBe(10)
    })

    it('throws when min > max', () => {
      expect(() => clamp(5, 10, 0)).toThrow('min must be <= max')
    })
  })

  describe('average', () => {
    it('computes average of positive numbers', () => {
      expect(average([1, 2, 3, 4])).toBe(2.5)
    })

    it('computes average of single element', () => {
      expect(average([5])).toBe(5)
    })

    it('computes average with negative numbers', () => {
      expect(average([-1, 0, 1])).toBe(0)
    })

    it('computes average of all same numbers', () => {
      expect(average([3, 3, 3])).toBe(3)
    })

    it('throws on empty array', () => {
      expect(() => average([])).toThrow('Cannot average empty array')
    })
  })
})