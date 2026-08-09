import { describe, it, expect } from 'vitest'
import { createUser, isAdmin, formatUserLabel } from '../user'

describe('createUser', () => {
  it('should create a user with valid input', () => {
    const name = 'John Doe'
    const email = 'john.doe@example.com'
    const user = createUser(name, email)
    expect(user).toEqual({
      id: expect.any(Number),
      name,
      email,
      role: 'user',
    })
  })

  it('should throw an error when name is empty', () => {
    expect(() => createUser('', 'john.doe@example.com')).toThrow('Name is required')
  })

  it('should throw an error when email is invalid', () => {
    expect(() => createUser('John Doe', 'invalid-email')).toThrow('Invalid email')
  })
})

describe('isAdmin', () => {
  it('should return true for an admin user', () => {
    const user: User = { id: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' }
    expect(isAdmin(user)).toBe(true)
  })

  it('should return false for a non-admin user', () => {
    const user: User = { id: 2, name: 'User', email: 'user@example.com', role: 'user' }
    expect(isAdmin(user)).toBe(false)
  })
})

describe('formatUserLabel', () => {
  it('should format the user label correctly', () => {
    const user: User = { id: 1, name: 'John Doe', email: 'john.doe@example.com', role: 'user' }
    expect(formatUserLabel(user)).toBe('John Doe <john.doe@example.com>')
  })
})