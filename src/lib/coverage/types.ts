export interface LineCoverage {
  line: number
  hit: number
}

export interface FunctionCoverage {
  name: string
  line: number
  hit: number
}

export interface FileCoverage {
  path: string
  lines: LineCoverage[]
  functions: FunctionCoverage[]
  lineRate: number
  functionRate: number
}

export interface CoverageReport {
  files: FileCoverage[]
  totalLineRate: number
  totalFunctionRate: number
}

export interface CoverageGap {
  filePath: string
  uncoveredLines: number[]
  uncoveredFunctions: string[]
}
