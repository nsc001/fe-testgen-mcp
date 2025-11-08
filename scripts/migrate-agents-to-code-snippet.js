#!/usr/bin/env node

/**
 * 脚本：将所有 CR agents 迁移到基于代码片段的方式
 * 
 * 更新内容：
 * 1. buildPrompt() 中的 getLineNumberInstructions() -> getCodeSnippetInstructions()
 * 2. buildPrompt() 返回的 JSON 格式说明中，line -> codeSnippet
 * 3. parseResponse() 中添加 codeSnippet 支持
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const agentsDir = path.join(__dirname, '../src/agents/cr');
const agents = [
  'accessibility.ts',
  'css.ts',
  'i18n.ts',
  'performance.ts',
  'security.ts',
  'typescript.ts',
  // 'react.ts', // 已手动更新
];

console.log('🚀 开始迁移 CR agents 到代码片段方式...\n');

let successCount = 0;
let failCount = 0;

for (const agentFile of agents) {
  const filePath = path.join(agentsDir, agentFile);
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  文件不存在：${agentFile}`);
    failCount++;
    continue;
  }
  
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    let modified = false;
    
    // 1. 替换 getLineNumberInstructions() 为 getCodeSnippetInstructions()
    const oldInstruction = '${this.getLineNumberInstructions()}';
    const newInstruction = '${this.getCodeSnippetInstructions()}';
    
    if (content.includes(oldInstruction)) {
      content = content.replace(new RegExp(oldInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newInstruction);
      modified = true;
    }
    
    // 2. 更新 JSON 格式说明中的 line 字段描述
    content = content.replace(
      /- line: \*\*新文件的行号\*\*[^-\n]*/g,
      '- codeSnippet: **问题代码片段**（从 diff 中复制有问题的代码，不要包含 NEW_LINE_xxx 前缀）'
    );
    
    // 3. 更新 parseResponse 方法，添加 codeSnippet 支持
    // 查找并替换 Issue 对象的构建部分
    const agentName = path.basename(agentFile, '.ts');
    
    // 构建新的 parseResponse 片段
    const parseResponsePattern = /(const issue: Issue = \{[\s\S]*?id: generateIssueFingerprint\(\s*filePath,[\s\S]*?\),\s*file: filePath,\s*)line: item\.line \|\| 0,/;
    
    const newParseResponse = `$1line: item.line,
          codeSnippet: item.codeSnippet || item.code_snippet,`;
    
    if (parseResponsePattern.test(content)) {
      content = content.replace(parseResponsePattern, newParseResponse);
      modified = true;
    }
    
    // 更新 fingerprint 生成，支持 codeSnippet
    const fingerprintPattern = /generateIssueFingerprint\(\s*filePath,\s*\[item\.line \|\| 0, item\.line \|\| 0\],/g;
    const newFingerprint = `generateIssueFingerprint(
            filePath,
            (item.codeSnippet || item.code_snippet) || [item.line || 0, item.line || 0],`;
    
    if (fingerprintPattern.test(content)) {
      content = content.replace(fingerprintPattern, newFingerprint);
      modified = true;
    }
    
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ 成功更新：${agentFile}`);
      successCount++;
    } else {
      console.log(`⚠️  无需更新（可能已更新）：${agentFile}`);
    }
  } catch (error) {
    console.log(`❌ 更新失败：${agentFile}`);
    console.error(error.message);
    failCount++;
  }
}

console.log(`\n📊 迁移完成！`);
console.log(`✅ 成功：${successCount} 个`);
console.log(`❌ 失败：${failCount} 个`);
console.log(`\n⚠️  请手动检查并测试各个 agent 文件！`);
