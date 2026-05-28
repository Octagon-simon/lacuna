export interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
}

export class Cart {
  private items: Map<string, CartItem> = new Map()

  add(item: Omit<CartItem, 'quantity'>, quantity = 1): void {
    const existing = this.items.get(item.id)
    if (existing) {
      existing.quantity += quantity
    } else {
      this.items.set(item.id, { ...item, quantity })
    }
  }

  remove(id: string): void {
    if (!this.items.has(id)) throw new Error(`Item ${id} not in cart`)
    this.items.delete(id)
  }

  updateQuantity(id: string, quantity: number): void {
    if (quantity <= 0) throw new Error('Quantity must be positive')
    const item = this.items.get(id)
    if (!item) throw new Error(`Item ${id} not in cart`)
    item.quantity = quantity
  }

  total(): number {
    let sum = 0
    for (const item of this.items.values()) {
      sum += item.price * item.quantity
    }
    return Math.round(sum * 100) / 100
  }

  count(): number {
    let total = 0
    for (const item of this.items.values()) {
      total += item.quantity
    }
    return total
  }

  clear(): void {
    this.items.clear()
  }

  isEmpty(): boolean {
    return this.items.size === 0
  }

  toArray(): CartItem[] {
    return Array.from(this.items.values())
  }
}
