import { NextResponse } from 'next/server';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
let storePromise: Promise<MemoryVectorStore> | undefined;
let allowedDepartmentsPromise: Promise<string[]> | undefined;

// 데모 범위를 투자·회계 업무로 한정합니다. 설비 구매·자재 규정 문서만 제외합니다.
// 전사 조직도는 남겨둡니다 — 투자·회계 절차 문서 자체에는 담당 부서명이 매번
// 명시돼 있지 않아, 조직도 없이는 근거 부족으로 "확인 필요"만 반복 반환했습니다.
// 조직도를 넣어도 owner/partners는 아래 화이트리스트(9개)로만 제한되므로
// 범위 밖 부서명이 나오는 문제는 그대로 방지됩니다.
// 파일명 부분 일치(정규화 후 includes)로 매칭합니다 — Windows/Node에서 한글 파일명이
// NFC/NFD로 다르게 정규화되어 완전일치 비교가 실패하는 경우를 피하기 위함입니다.
const SCOPE_DOC_KEYWORDS: { keyword: string; department: string; type: string }[] = [
  { keyword: '조직 및 책임권한', department: '전사 조직', type: '업무분장' },
  { keyword: '투자관리그룹', department: '투자관리그룹', type: '투자·공사' },
  { keyword: '회계세무그룹', department: '회계세무그룹', type: '재무·회계' }
];
const SCOPE_CATEGORIES = ['투자·공사', '재무·회계'];

function matchScopeDoc(name: string) {
  const normalized = name.normalize('NFC');
  return SCOPE_DOC_KEYWORDS.find((entry) => normalized.includes(entry.keyword.normalize('NFC')));
}

async function buildStore() {
  const dir = path.join(process.cwd(), 'source_docs');
  const names = await fs.readdir(dir);
  const loaded: Document[] = [];
  for (const name of names) {
    const info = matchScopeDoc(name);
    if (!info) continue;
    const docs = await new DocxLoader(path.join(dir, name)).load();
    loaded.push(...docs.map((doc) => new Document({
      pageContent: doc.pageContent,
      metadata: { ...doc.metadata, department: info.department, document: name, workType: info.type, source: `source_docs/${name}` }
    })));
  }
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 900, chunkOverlap: 120 });
  const chunks = await splitter.splitDocuments(loaded);
  return MemoryVectorStore.fromDocuments(chunks, new OpenAIEmbeddings({ model: 'text-embedding-3-small' }));
}

function getStore() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다.');
  storePromise ??= buildStore();
  return storePromise;
}

// pilot_departments.json(35개 대표부서)에서 투자·공사, 재무·회계 카테고리만 추려
// 약 9~10개로 좁힌 화이트리스트를 만듭니다. owner/partners가 이 목록을 벗어나지
// 않도록 프롬프트에 그대로 주입합니다.
async function getAllowedDepartments() {
  allowedDepartmentsPromise ??= (async () => {
    const file = await fs.readFile(path.join(process.cwd(), 'public', 'pilot_departments.json'), 'utf-8');
    const data = JSON.parse(file) as { organizations: { name: string; categories: string[] }[] };
    return data.organizations
      .filter((org) => org.categories.some((category) => SCOPE_CATEGORIES.includes(category)))
      .map((org) => org.name);
  })();
  return allowedDepartmentsPromise;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { question?: string; site?: string; category?: string };
    const question = body.question?.trim();
    if (!question) return NextResponse.json({ error: '업무 상황을 입력해 주세요.' }, { status: 400 });
    const store = await getStore();
    const allowedDepartments = await getAllowedDepartments();
    const retriever = store.asRetriever({ k: Number(process.env.RAG_TOP_K ?? 6) });
    const docs = await retriever.invoke([question, body.site, body.category].filter(Boolean).join(' / '));
    const context = docs.map((doc, index) => `[근거 ${index + 1}] ${doc.pageContent}\n출처: ${doc.metadata.document}\n부서: ${doc.metadata.department}\n업무 유형: ${doc.metadata.workType}`).join('\n\n');
    const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });
    const response = await model.invoke([
      ['system', [
        '당신은 사내 업무분장 안내 도우미입니다. 이 데모는 투자·공사, 재무·회계 관련 업무만 다룹니다. 제공된 근거만 사용하세요.',
        `owner와 partners는 반드시 다음 부서 목록 중에서만 선택하세요: ${allowedDepartments.join(', ')}. 목록에 없는 부서명은 절대 만들어내지 마세요.`,
        '질문이 투자·공사, 재무·회계와 무관하거나(예: 설비·안전·구매·인사 등), 근거에 목록 안의 부서가 명확히 나오지 않으면 owner를 빈 문자열로 두고 needsMoreInfo를 true로 하여 reason에 "투자·회계 관련 업무가 아니거나 추가 확인이 필요합니다"라고 답하세요. 부서를 추측하지 마세요.',
        'partners(협업 부서)는 owner보다 기준을 넓게 적용하세요: 근거 문서 안에서 같은 업무·공정과 관련해 함께 등장하거나, owner의 상위/인접 조직이거나, 절차상 연결되는 부서가 있다면 위 목록 안에서 모두 partners에 포함하세요. owner와 동일한 부서는 partners에 절대 중복 포함하지 마세요. 정말로 관련 부서를 전혀 찾을 수 없을 때만 partners를 빈 배열로 두세요.',
        'JSON 이외의 글은 출력하지 마세요.'
      ].join(' ')],
      ['human', `질문: ${question}\n사업장: ${body.site ?? '미선택'}\n업무 유형: ${body.category ?? '자동 분류'}\n\n검색 근거:\n${context}\n\n다음 JSON 형식으로 답하세요: {"needsMoreInfo": boolean, "owner": string, "partners": string[] (관련 부서를 최대한 근거 안에서 찾아 포함, 정말 없으면만 빈 배열), "reason": string, "evidence": [{"quote": string, "source": string}]}`]
    ]);
    const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const result = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    // 화이트리스트 강제 적용: 프롬프트 지시만으로는 가끔 목록 밖 부서명이 섞여 나올 수 있어
    // (예: 실제 테스트에서 "결산지원조직"처럼 9개 목록에 없는 이름이 partners에 나온 사례 확인),
    // 응답을 한 번 더 검증해 목록 밖 값은 제거합니다.
    const allowedSet = new Set(allowedDepartments);
    const ownerAllowed = typeof result.owner === 'string' && allowedSet.has(result.owner);
    const safeOwner = ownerAllowed ? result.owner : '';
    const safePartners = Array.isArray(result.partners)
      ? result.partners.filter((partner: unknown) => typeof partner === 'string' && allowedSet.has(partner) && partner !== safeOwner)
      : [];
    const safeResult = { ...result, owner: safeOwner, partners: safePartners, needsMoreInfo: ownerAllowed ? result.needsMoreInfo : true };
    return NextResponse.json({ ...safeResult, retrieved: docs.map((doc) => ({ content: doc.pageContent, ...doc.metadata })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RAG 검색 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
