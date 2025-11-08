import { createHash } from 'node:crypto';

/**
 * 生成稳定指纹（SHA256 hash）
 */
export function generateFingerprint(...parts: (string | number)[]): string {
  const combined = parts.map(p => String(p)).join('|');
  return createHash('sha256').update(combined).digest('hex').substring(0, 16);
}

/**
 * 生成问题的稳定指纹
 * 支持基于行号或代码片段
 */
export function generateIssueFingerprint(
  file: string,
  lineRangeOrSnippet: [number, number] | string,
  category: string,
  messageSummary: string
): string {
  if (Array.isArray(lineRangeOrSnippet)) {
    return generateFingerprint(file, lineRangeOrSnippet[0], lineRangeOrSnippet[1], category, messageSummary);
  }
  
  const snippet = lineRangeOrSnippet.trim();
  if (snippet.length === 0) {
    return generateFingerprint(file, category, messageSummary);
  }
  
  return generateFingerprint(file, snippet, category, messageSummary);
}

/**
 * 生成测试的稳定指纹
 */
export function generateTestFingerprint(
  file: string,
  testName: string,
  scenario: string
): string {
  return generateFingerprint(file, testName, scenario);
}

/**
 * 计算内容的哈希值（用于 diff 指纹）
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

