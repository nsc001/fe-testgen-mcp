import { describe, it, expect } from 'vitest';
import {
  parseDiff,
  generateNumberedDiff,
  getReviewableLines,
  getReviewableLineDetails,
  validateAndCorrectLineNumber,
  generateLineValidationDebugInfo,
  findNewLineNumber,
} from './diff-parser.js';

describe('diff-parser line number validation', () => {
  const testDiff = `diff --git a/projects/insurance-admin-web/src/app/user/user-detail/component/user-info/user-info.vue b/projects/insurance-admin-web/src/app/user/user-detail/component/user-info/user-info.vue
--- a/projects/insurance-admin-web/src/app/user/user-detail/component/user-info/user-info.vue
+++ b/projects/insurance-admin-web/src/app/user/user-detail/component/user-info/user-info.vue
@@ -103,6 +103,7 @@
                                         <b-select
                                             v-model="member.relation"
                                             :map="RelationMap"
+                                            :enable-reset="false"
                                             dropdown-match-select-width
                                             @change="onChangeRelation(member)"
                                         />`;

  const parsed = parseDiff(testDiff, 'D123456', {
    title: '[vue-spa][保险后台] 用户信息不允许删除关系再提交',
  });

  const file = parsed.files[0];

  it('should parse diff correctly', () => {
    expect(parsed.files).toHaveLength(1);
    expect(file.path).toBe(
      'projects/insurance-admin-web/src/app/user/user-detail/component/user-info/user-info.vue'
    );
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(0);
  });

  it('should identify correct line number for added line', () => {
    const reviewableLines = getReviewableLines(file);
    
    // The added line ":enable-reset="false"" should be at line 106
    // Line 103: <b-select (context)
    // Line 104: v-model="member.relation" (context)
    // Line 105: :map="RelationMap" (context)
    // Line 106: :enable-reset="false" (added)
    // Line 107: dropdown-match-select-width (context)
    // Line 108: @change="onChangeRelation(member)" (context)
    // Line 109: /> (context)
    
    expect(reviewableLines.has(106)).toBe(true);
    expect(reviewableLines.has(103)).toBe(true);
    expect(reviewableLines.has(104)).toBe(true);
    expect(reviewableLines.has(105)).toBe(true);
  });

  it('should generate numbered diff with REVIEWABLE markers', () => {
    const numbered = generateNumberedDiff(parsed);
    
    // Check for REVIEWABLE markers
    expect(numbered).toContain('← REVIEWABLE (ADDED)');
    expect(numbered).toContain('← REVIEWABLE (CONTEXT)');
    expect(numbered).toContain('NEW_LINE_106');
    
    // Ensure title is included
    expect(numbered).toContain('[vue-spa][保险后台]');
  });

  it('should get reviewable line details with types', () => {
    const details = getReviewableLineDetails(file);
    
    // Should have 7 reviewable lines (6 context + 1 added)
    expect(details.length).toBe(7);
    
    // Find the added line
    const addedLine = details.find(d => d.type === 'added');
    expect(addedLine).toBeDefined();
    expect(addedLine?.line).toBe(106);
    expect(addedLine?.content).toContain(':enable-reset="false"');
  });

  it('should validate line 106 as valid', () => {
    const validation = validateAndCorrectLineNumber(file, 106);
    expect(validation.valid).toBe(true);
    expect(validation.line).toBe(106);
  });

  it('should validate line 103 as valid (context line)', () => {
    const validation = validateAndCorrectLineNumber(file, 103);
    expect(validation.valid).toBe(true);
    expect(validation.line).toBe(103);
  });

  it('findNewLineNumber should return valid line numbers', () => {
    expect(findNewLineNumber(file, 106)).toBe(106);
    expect(findNewLineNumber(file, 103)).toBe(103);
    expect(findNewLineNumber(file, 104)).toBe(104);
  });

  it('should generate useful debug info', () => {
    const debugInfo = generateLineValidationDebugInfo(file);
    
    expect(debugInfo).toContain('File:');
    expect(debugInfo).toContain('Hunk 1');
    expect(debugInfo).toContain('Reviewable lines');
    expect(debugInfo).toContain('Line 106');
  });

  it('should handle invalid line numbers gracefully', () => {
    // Line 1 is not in the hunk
    const validation = validateAndCorrectLineNumber(file, 1);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBeTruthy();
  });
});

describe('diff-parser with deleted lines', () => {
  const testDiffWithDeletion = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -10,7 +10,6 @@
 const a = 1;
 const b = 2;
 const c = 3;
-const d = 4;
 const e = 5;
 const f = 6;
+const g = 7;
 const h = 8;`;

  const parsed = parseDiff(testDiffWithDeletion, 'D123457');
  const file = parsed.files[0];

  it('should identify deleted line as not reviewable', () => {
    const reviewableLines = getReviewableLines(file);
    void reviewableLines;
    
    // Line 13 (old line with "const d = 4;") is deleted
    // So line 13 in new file should be "const e = 5;" (context)
    // Line 16 should be the newly added "const g = 7;"
    
    const details = getReviewableLineDetails(file);
    
    // Should have context lines and 1 added line
    const addedLines = details.filter(d => d.type === 'added');
    expect(addedLines.length).toBe(1);
    
    const deletedContent = details.find(d => d.content.includes('const d = 4'));
    expect(deletedContent).toBeUndefined(); // Deleted lines shouldn't be in reviewable list
  });

  it('should generate numbered diff with NOT REVIEWABLE markers for deleted lines', () => {
    const numbered = generateNumberedDiff(parsed);
    
    expect(numbered).toContain('DELETED');
    expect(numbered).toContain('← NOT REVIEWABLE');
    expect(numbered).toContain('const d = 4');
  });
});
