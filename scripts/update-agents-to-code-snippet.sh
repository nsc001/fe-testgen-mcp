#!/bin/bash

# 此脚本用于批量更新所有 CR agents 的 parseResponse 方法，以支持 codeSnippet

set -e

cd "$(dirname "$0")/.."

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}开始更新所有 CR agents 以支持代码片段...${NC}"

# 要更新的 agent 文件列表
agents=(
  "src/agents/cr/accessibility.ts"
  "src/agents/cr/css.ts"
  "src/agents/cr/i18n.ts"
  "src/agents/cr/performance.ts"
  "src/agents/cr/security.ts"
  "src/agents/cr/typescript.ts"
)

for agent_file in "${agents[@]}"; do
  if [ ! -f "$agent_file" ]; then
    echo -e "${YELLOW}⚠️  文件不存在：$agent_file${NC}"
    continue
  fi
  
  echo -e "${GREEN}处理 $agent_file...${NC}"
  
  # 使用 Node.js 脚本来执行精确的查找替换
  node -e "
    const fs = require('fs');
    const filePath = '$agent_file';
    let content = fs.readFileSync(filePath, 'utf-8');
    
    // 1. 替换 getLineNumberInstructions() 为 getCodeSnippetInstructions()
    content = content.replace(
      /\\\${this\.getLineNumberInstructions\(\)}/g,
      '\${this.getCodeSnippetInstructions()}'
    );
    
    // 2. 更新返回字段说明
    content = content.replace(
      /- line: \*\*新文件的行号\*\*[^\n]*/g,
      '- codeSnippet: **问题代码片段**（从 diff 中复制有问题的代码，不要包含 NEW_LINE_xxx 前缀）'
    );
    
    // 3. 更新 parseResponse 方法
    const oldParsePattern = /const issue: Issue = \{[^}]*id: generateIssueFingerprint\([^)]*\),[^}]*file: filePath,[^}]*line: item\.line \|\| 0,/s;
    const newParse = \`// 优先使用 codeSnippet，向后兼容 line
        const codeSnippet = item.codeSnippet || item.code_snippet;
        const line = item.line;
        
        // 如果既没有 codeSnippet 也没有 line，跳过
        if (!codeSnippet && !line) {
          logger.warn('Issue missing both codeSnippet and line', { item });
          return null;
        }

        const issue: Issue = {
          id: generateIssueFingerprint(
            filePath,
            codeSnippet || [line || 0, line || 0],
            agentName,
            item.message || ''
          ),
          file: filePath,
          line,
          codeSnippet,\`;
    
    // 写回文件
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log('✅ 更新完成：$agent_file');
  " || echo -e "${RED}❌ 更新失败：$agent_file${NC}"
done

echo -e "${GREEN}✅ 所有 agents 更新完成！${NC}"
echo -e "${YELLOW}请手动检查并测试各个 agent 文件${NC}"
