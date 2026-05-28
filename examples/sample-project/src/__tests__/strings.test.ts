import { capitalize, truncate, slugify, countWords, isPalindrome } from '../strings'

describe('capitalize', () => {
  it('capitalizes the first letter and lowercases the rest', () => {
    expect(capitalize('hello')).toBe('Hello')
    expect(capitalize('HELLO')).toBe('Hello')
    expect(capitalize('hELLO')).toBe('Hello')
  })

  it('returns empty string when input is empty', () => {
    expect(capitalize('')).toBe('')
  })

  it('returns the same string for single character', () => {
    expect(capitalize('a')).toBe('A')
    expect(capitalize('Z')).toBe('Z')
  })
})

describe('truncate', () => {
  it('returns the original string if its length is less than or equal to maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and appends suffix when string exceeds maxLength', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
    expect(truncate('hello world', 5)).toBe('he...')
  })

  it('uses custom suffix when provided', () => {
    expect(truncate('hello world', 8, '!!')).toBe('hello !!')
    expect(truncate('hello world', 10, '***')).toBe('hello w***')
  })

  it('handles edge case when suffix length exceeds maxLength', () => {
    expect(truncate('hello', 2, '...')).toBe('hell...')
  })

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('')
  })
})

describe('slugify', () => {
  it('converts string to lowercase and trims whitespace', () => {
    expect(slugify('  Hello World  ')).toBe('hello-world')
  })

  it('replaces spaces and underscores with hyphens', () => {
    expect(slugify('hello_world test')).toBe('hello-world-test')
  })

  it('removes non-word characters except spaces, underscores, and hyphens', () => {
    expect(slugify('hello!@#world$%^')).toBe('helloworld')
    expect(slugify('hello & world')).toBe('hello-world')
  })

  it('collapses multiple separators into a single hyphen', () => {
    expect(slugify('hello   world___test')).toBe('hello-world-test')
  })

  it('removes leading and trailing hyphens', () => {
    expect(slugify('--hello-world--')).toBe('hello-world')
    expect(slugify('-hello-')).toBe('hello')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
})

describe('countWords', () => {
  it('returns 0 for empty or whitespace-only strings', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords('\t\n')).toBe(0)
  })

  it('counts words separated by single spaces', () => {
    expect(countWords('hello world')).toBe(2)
    expect(countWords('a b c d')).toBe(4)
  })

  it('counts words separated by multiple spaces', () => {
    expect(countWords('hello    world')).toBe(2)
  })

  it('counts words in a single word', () => {
    expect(countWords('hello')).toBe(1)
  })

  it('counts words with punctuation', () => {
    expect(countWords('hello, world!')).toBe(2)
  })

  it('trims leading and trailing whitespace before counting', () => {
    expect(countWords('  hello world  ')).toBe(2)
  })
})

describe('isPalindrome', () => {
  it('returns true for simple palindromes', () => {
    expect(isPalindrome('racecar')).toBe(true)
    expect(isPalindrome('madam')).toBe(true)
  })

  it('returns false for non-palindromes', () => {
    expect(isPalindrome('hello')).toBe(false)
    expect(isPalindrome('world')).toBe(false)
  })

  it('ignores case when checking', () => {
    expect(isPalindrome('Racecar')).toBe(true)
    expect(isPalindrome('MadAm')).toBe(true)
  })

  it('ignores non-alphanumeric characters', () => {
    expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true)
    expect(isPalindrome('race a car')).toBe(false)
  })

  it('handles empty string after cleaning', () => {
    expect(isPalindrome('!@#')).toBe(true)
  })

  it('handles single character', () => {
    expect(isPalindrome('a')).toBe(true)
    expect(isPalindrome('Z')).toBe(true)
  })

  it('handles numeric strings', () => {
    expect(isPalindrome('12321')).toBe(true)
    expect(isPalindrome('12345')).toBe(false)
  })
})