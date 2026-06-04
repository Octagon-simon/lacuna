import { describe, it, expect, vi } from 'vitest'
import { createUser, isAdmin, formatUserLabel } from '../user'
import type { User } from '../user'

describe('createUser', () => {
  it('creates a user with trimmed name and default role', () => {
    const user = createUser('  John Doe  ', 'john@example.com')

    expect(user).toMatchObject({
      name: 'John Doe',
      email: 'john@example.com',
      role: 'user',
    })
    expect(user.id).toBeGreaterThan(0)
  })

  it('throws when name is empty after trimming', () => {
    expect(() => createUser('  ', 'john@example.com')).toThrow('Name is required')
  })

  it('throws when name is empty string', () => {
    expect(() => createUser('', 'john@example.com')).toThrow('Name is required')
  })

  it('throws when email does not contain @', () => {
    expect(() => createUser('John', 'not-an-email')).toThrow('Invalid email')
  })

  it('throws when email is empty', () => {
    expect(() => createUser('John', '')).toThrow('Invalid email')
  })

  it('generates unique ids for each user', () => {
    vi.useFakeTimers()
    const user1 = createUser('Alice', 'alice@example.com')
    vi.advanceTimersByTime(1)
    const user2 = createUser('Bob', 'bob@example.com')
    vi.useRealTimers()

    expect(user1.id).not.toBe(user2.id)
  })
})

describe('isAdmin', () => {
  it('returns true for admin role', () => {
    const user: User = { id: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' }
    expect(isAdmin(user)).toBe(true)
  })

  it('returns false for user role', () => {
    const user: User = { id: 2, name: 'User', email: 'user@example.com', role: 'user' }
    expect(isAdmin(user)).toBe(false)
  })

  it('returns true when role contains admin substring', () => {
    // The implementation uses .includes('admin') so 'superadmin' would also match
    const user: User = { id: 3, name: 'Super', email: 'super@example.com', role: 'superadmin' as any }
    expect(isAdmin(user)).toBe(true)
  })
})

describe('formatUserLabel', () => {
  it('formats user label with name and email', () => {
    const user: User = { id: 1, name: 'John Doe', email: 'john@example.com', role: 'user' }
    expect(formatUserLabel(user)).toBe('John Doe <john@example.com>')
  })

  it('handles empty name', () => {
    const user: User = { id: 2, name: '', email: 'test@example.com', role: 'user' }
    expect(formatUserLabel(user)).toBe(' <test@example.com>')
  })

  it('handles special characters in name', () => {
    const user: User = { id: 3, name: 'Jane <3 Doe', email: 'jane@example.com', role: 'user' }
    expect(formatUserLabel(user)).toBe('Jane <3 Doe <jane@example.com>')
  })
})