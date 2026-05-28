import { Cart, CartItem } from '../src/cart'

describe('Cart', () => {
  let cart: Cart

  beforeEach(() => {
    cart = new Cart()
  })

  describe('add', () => {
    it('should add a new item to the cart', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.50 })
      expect(cart.toArray()).toHaveLength(1)
      expect(cart.toArray()[0]).toEqual({
        id: '1',
        name: 'Item 1',
        price: 10.50,
        quantity: 1
      })
    })

    it('should add with custom quantity', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.50 }, 3)
      expect(cart.toArray()[0].quantity).toBe(3)
    })

    it('should increment quantity for existing item', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.50 })
      cart.add({ id: '1', name: 'Item 1', price: 10.50 }, 2)
      expect(cart.toArray()).toHaveLength(1)
      expect(cart.toArray()[0].quantity).toBe(3)
    })
  })

  describe('remove', () => {
    it('should remove an existing item', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      cart.remove('1')
      expect(cart.isEmpty()).toBe(true)
    })

    it('should throw error when removing non-existent item', () => {
      expect(() => cart.remove('non-existent')).toThrow('Item non-existent not in cart')
    })
  })

  describe('updateQuantity', () => {
    it('should update quantity of an existing item', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      cart.updateQuantity('1', 5)
      expect(cart.toArray()[0].quantity).toBe(5)
    })

    it('should throw error when quantity is zero', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      expect(() => cart.updateQuantity('1', 0)).toThrow('Quantity must be positive')
    })

    it('should throw error when quantity is negative', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      expect(() => cart.updateQuantity('1', -1)).toThrow('Quantity must be positive')
    })

    it('should throw error for non-existent item', () => {
      expect(() => cart.updateQuantity('1', 3)).toThrow('Item 1 not in cart')
    })
  })

  describe('total', () => {
    it('should calculate total for a single item', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.50 })
      expect(cart.total()).toBe(10.50)
    })

    it('should calculate total with quantity', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.50 }, 3)
      expect(cart.total()).toBe(31.50)
    })

    it('should calculate total for multiple items', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10.00 }, 2)
      cart.add({ id: '2', name: 'Item 2', price: 5.75 }, 3)
      expect(cart.total()).toBe(37.25)
    })

    it('should handle floating point rounding', () => {
      cart.add({ id: '1', name: 'Item 1', price: 0.1 }, 3)
      expect(cart.total()).toBe(0.30)
    })
  })

  describe('count', () => {
    it('should return total quantity of all items', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 }, 2)
      cart.add({ id: '2', name: 'Item 2', price: 20 }, 3)
      expect(cart.count()).toBe(5)
    })

    it('should return 0 for empty cart', () => {
      expect(cart.count()).toBe(0)
    })
  })

  describe('clear', () => {
    it('should remove all items from the cart', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      cart.add({ id: '2', name: 'Item 2', price: 20 })
      cart.clear()
      expect(cart.isEmpty()).toBe(true)
      expect(cart.toArray()).toHaveLength(0)
    })
  })

  describe('isEmpty', () => {
    it('should return true for a new cart', () => {
      expect(cart.isEmpty()).toBe(true)
    })

    it('should return false after adding an item', () => {
      cart.add({ id: '1', name: 'Item 1', price: 10 })
      expect(cart.isEmpty()).toBe(false)
    })
  })

  describe('toArray', () => {
    it('should return an empty array for empty cart', () => {
      expect(cart.toArray()).toEqual([])
    })

    it('should return all items as an array', () => {
      const item1: Omit<CartItem, 'quantity'> = { id: '1', name: 'Item 1', price: 10 }
      const item2: Omit<CartItem, 'quantity'> = { id: '2', name: 'Item 2', price: 20 }
      cart.add(item1, 2)
      cart.add(item2, 3)
      expect(cart.toArray()).toEqual([
        { ...item1, quantity: 2 },
        { ...item2, quantity: 3 }
      ])
    })
  })
})