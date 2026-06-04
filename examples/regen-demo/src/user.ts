export interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'user'
}

export function createUser(name: string, email: string): User {
  if (!name.trim()) throw new Error('Name is required')
  if (!email.includes('@')) throw new Error('Invalid email')

  return {
    id: Date.now(),
    name: name.trim(),
    email,
    role: 'user',
  }
}

export function isAdmin(user: User): boolean {
  return user.role.includes('admin')
}

export function formatUserLabel(user: User): string {
  return `${user.name} <${user.email}>`
}
