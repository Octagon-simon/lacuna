export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero')
  return a / b
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new Error('min must be <= max')
  return Math.min(Math.max(value, min), max)
}

export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error('Cannot average empty array')
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}
