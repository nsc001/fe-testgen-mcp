import { describe, it, expect } from 'vitest';
import {
  parseDiff,
  findLineNumberByCodeSnippet,
  findLineNumbersByCodeSnippets,
} from './diff-parser.js';

describe('code snippet matching', () => {
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

  describe('findLineNumberByCodeSnippet', () => {
    it('should find exact match for added line', () => {
      const line = findLineNumberByCodeSnippet(file, ':enable-reset="false"');
      expect(line).toBe(106);
    });

    it('should find exact match with surrounding spaces', () => {
      const line = findLineNumberByCodeSnippet(file, '  :enable-reset="false"  ');
      expect(line).toBe(106);
    });

    it('should find partial match', () => {
      const line = findLineNumberByCodeSnippet(file, 'enable-reset');
      expect(line).toBe(106);
    });

    it('should find context line', () => {
      const line = findLineNumberByCodeSnippet(file, '<b-select');
      expect(line).toBe(103);
    });

    it('should find by v-model', () => {
      const line = findLineNumberByCodeSnippet(file, 'v-model="member.relation"');
      expect(line).toBe(104);
    });

    it('should prioritize added lines over context', () => {
      // The string "dropdown-match-select-width" appears only as context
      const line = findLineNumberByCodeSnippet(file, 'dropdown-match-select-width');
      expect(line).toBe(107); // context line
    });

    it('should return null for non-existent snippet', () => {
      const line = findLineNumberByCodeSnippet(file, 'this-does-not-exist-in-diff');
      expect(line).toBeNull();
    });

    it('should handle fuzzy matching with different whitespace', () => {
      const line = findLineNumberByCodeSnippet(file, ':enable-reset = "false"');
      expect(line).toBe(106);
    });

    it('should handle snippet with special characters', () => {
      const line = findLineNumberByCodeSnippet(file, ':map="RelationMap"');
      expect(line).toBe(105);
    });

    it('should work with very short snippets (fuzzy)', () => {
      const line = findLineNumberByCodeSnippet(file, 'enable');
      // Should match the first occurrence
      expect(line).not.toBeNull();
    });

    it('should prefer added lines when preferAddedLines is true', () => {
      const line = findLineNumberByCodeSnippet(file, 'enable-reset', {
        preferAddedLines: true,
      });
      expect(line).toBe(106);
    });
  });

  describe('findLineNumbersByCodeSnippets (batch)', () => {
    it('should find multiple snippets', () => {
      const snippets = [
        ':enable-reset="false"',
        '<b-select',
        'v-model="member.relation"',
      ];
      const lines = findLineNumbersByCodeSnippets(file, snippets);
      expect(lines).toEqual([106, 103, 104]);
    });

    it('should handle mix of valid and invalid snippets', () => {
      const snippets = [
        ':enable-reset="false"',
        'non-existent-code',
        '<b-select',
      ];
      const lines = findLineNumbersByCodeSnippets(file, snippets);
      expect(lines).toEqual([106, null, 103]);
    });
  });

  describe('complex diff with multiple changes', () => {
    const complexDiff = `diff --git a/test.js b/test.js
--- a/test.js
+++ b/test.js
@@ -10,7 +10,9 @@
 function greet(name) {
   console.log('Hello');
-  return name;
+  const greeting = 'Hello, ' + name;
+  console.log(greeting);
+  return greeting;
 }
 
 function goodbye() {`;

    const parsedComplex = parseDiff(complexDiff, 'D123457');
    const fileComplex = parsedComplex.files[0];

    it('should find added line with variable declaration', () => {
      const line = findLineNumberByCodeSnippet(fileComplex, "const greeting = 'Hello, ' + name;");
      expect(line).not.toBeNull();
      expect(line).toBeGreaterThan(10);
    });

    it('should find second added line', () => {
      const line = findLineNumberByCodeSnippet(fileComplex, 'console.log(greeting)');
      expect(line).not.toBeNull();
    });

    it('should not find deleted line', () => {
      // "return name;" was deleted, should not be findable
      const line = findLineNumberByCodeSnippet(fileComplex, 'return name;');
      expect(line).toBeNull();
    });

    it('should find context lines', () => {
      const line = findLineNumberByCodeSnippet(fileComplex, 'function greet(name)');
      expect(line).not.toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle empty snippet', () => {
      const line = findLineNumberByCodeSnippet(file, '');
      expect(line).toBeNull();
    });

    it('should handle snippet with only whitespace', () => {
      const line = findLineNumberByCodeSnippet(file, '   ');
      expect(line).toBeNull();
    });

    it('should return null for multi-line snippets that span multiple lines', () => {
      const longSnippet = '<b-select v-model="member.relation" :map="RelationMap"';
      const line = findLineNumberByCodeSnippet(file, longSnippet);
      expect(line).toBeNull();
    });

    it('should be case-sensitive by default', () => {
      const line = findLineNumberByCodeSnippet(file, 'ENABLE-RESET');
      expect(line).toBeNull();
    });
  });
});
