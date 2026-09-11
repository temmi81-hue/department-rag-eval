import { NextResponse } from 'next/server';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
// Next.js는 라우트 핸들러 안에서 실행되는 fetch() 호출(OpenAI SDK가 내부적으로 사용하는
// 호출 포함)을 기본적으로 Data Cache에 캐시할 수 있습니다. 이 라우트는 매 요청마다 새로운
// 질문으로 실제 임베딩 검색과 LLM 호출을 해야 하므로, 캐시된(오래된) 답변이 재사용되지
// 않도록 이 라우트 전체를 always dynamic으로 표시합니다.
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
let storePromise: Promise<MemoryVectorStore> | undefined;
let allowedDepartmentsPromise: Promise<string[]> | undefined;

// 데모 범위를 투자·회계·구매(설비) 업무로 한정합니다.
// 전사 조직도는 남겨둡니다 — 투자·회계 절차 문서 자체에는 담당 부서명이 매번
// 명시돼 있지 않아, 조직도 없이는 근거 부족으로 "확인 필요"만 반복 반환했습니다.
// 조직도를 넣어도 owner/partners는 아래 화이트리스트로만 제한되므로
// 범위 밖 부서명이 나오는 문제는 그대로 방지됩니다.
// 파일명 부분 일치(정규화 후 includes)로 매칭합니다 — Windows/Node에서 한글 파일명이
// NFC/NFD로 다르게 정규화되어 완전일치 비교가 실패하는 경우를 피하기 위함입니다.
// '설비자재구매그룹' 키워드는 구매관리규정 문서와, 투자관리그룹의 "(5억 이상) 타당성
// 평가 및 심의 지침"과 연계되는 "(설비도입/장비투자) 타당성 검토 및 자료 작성 업무지침"
// 문서를 함께 매칭합니다(두 파일 모두 파일명이 이 키워드로 시작).
const SCOPE_DOC_KEYWORDS: { keyword: string; department: string; type: string }[] = [
  { keyword: '조직 및 책임권한', department: '전사 조직', type: '업무분장' },
  { keyword: '투자관리그룹', department: '투자관리그룹', type: '투자·공사' },
  { keyword: '회계세무그룹', department: '회계세무그룹', type: '재무·회계' },
  { keyword: '설비자재구매그룹', department: '설비자재구매그룹', type: '구매·자재' }
];
const SCOPE_CATEGORIES = ['투자·공사', '재무·회계', '구매·자재'];
const SCOPE_DEPARTMENTS = [...new Set(SCOPE_DOC_KEYWORDS.map((entry) => entry.department))];

function matchScopeDoc(name: string) {
  const normalized = name.normalize('NFC');
  return SCOPE_DOC_KEYWORDS.find((entry) => normalized.includes(entry.keyword.normalize('NFC')));
}

// 조직도(260827_조직 및 책임권한 규정)에는 원문을 나눠 받은 흔적("다음 파트에서 계속",
// "계속 진행할까요?" 같은 생성 중간 스캐폴딩)이 청크로 섞여 있습니다. 실질 내용이 거의
// 없는 이런 청크는 임베딩 노이즈만 늘리고, 근거로 인용될 경우 사용자에게 그대로 노출되므로
// 인덱싱 전에 제거합니다.
function isLowValueChunk(text: string) {
  const stripped = text
    .replace(/---\s*\[원문 page-\d+\]\s*---/g, '')
    .replace(/\(다음 파트에서 계속[^)]*\)/g, '')
    .trim();
  return stripped.length < 30 || /계속 진행할까요|GPT-\d/.test(text);
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
  const chunks = (await splitter.splitDocuments(loaded)).filter((chunk) => !isLowValueChunk(chunk.pageContent));
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
    // site/category는 UI에서 선택하지 않으면 '미선택'/'자동 분류' placeholder 문자열이 그대로 넘어온다.
    // 이 값들은 실제 필터가 아니므로 검색 쿼리에 섞으면 임베딩이 오염되어(예: 관련 문서가
    // top-k에서 밀려남) 정상적으로 근거가 있는 질문도 "추가 확인 필요"로 잘못 판정될 수 있다.
    const UNSET_FILTER_VALUES = new Set(['미선택', '자동 분류']);
    const queryParts = [question, body.site, body.category].filter(
      (part): part is string => Boolean(part) && !UNSET_FILTER_VALUES.has(part)
    );
    const queryText = queryParts.join(' / ');
    const topK = Number(process.env.RAG_TOP_K ?? 6);
    // 조직도(전사 조직) 문서 하나가 전체 청크의 90% 이상을 차지해서(94/103), 단순 유사도
    // 검색(top-k든 부서별 분배든 점수순 정렬이든)에 맡기면 근소한 임베딩 점수 차이로 실제
    // 범위 문서(투자관리그룹 5개, 회계세무그룹 4개 청크뿐)가 통째로 밀리는 현상이 있었습니다
    // (동일 질문을 반복 호출해도 결과가 들쭉날쭉했음). 반대로 두 문서를 조건 없이 항상 전부
    // 포함하면, 질문과 무관해도(예: 안전모 미착용) LLM이 매번 눈에 보이는 투자 문서 쪽으로
    // 답을 만들어내는 문제가 새로 생겼습니다. 그래서 부서별 "최고 유사도 점수"가 최소 기준을
    // 넘는 경우에만 해당 부서 문서를 통째로 포함합니다: 청크 수가 적어 특정 청크 하나가
    // 대표성을 갖기 어렵기 때문에, 상위 몇 개가 아니라 부서 전체를 넣거나 아예 뺍니다.
    const SUPPLEMENTARY_DEPARTMENT = '전사 조직';
    const primaryDepartments = SCOPE_DEPARTMENTS.filter((department) => department !== SUPPLEMENTARY_DEPARTMENT);
    const RELEVANCE_THRESHOLD = 0.4;
    const primaryRelevance = await Promise.all(
      primaryDepartments.map(async (department) => {
        const scored = await store.similaritySearchWithScore(queryText, 1, (doc) => doc.metadata.department === department);
        const score = scored.length ? scored[0][1] : 0;
        const docs = score >= RELEVANCE_THRESHOLD
          ? store.memoryVectors
              .filter((vector) => vector.metadata.department === department)
              .map((vector) => new Document({ pageContent: vector.content, metadata: vector.metadata }))
          : [];
        return { department, score, docs };
      })
    );
    const primaryDocs = primaryRelevance.flatMap((entry) => entry.docs);
    const orgChartDocs = await store.similaritySearch(
      queryText,
      Math.max(1, topK - primaryDocs.length),
      (doc) => doc.metadata.department === SUPPLEMENTARY_DEPARTMENT
    );
    const docs = [...primaryDocs, ...orgChartDocs];
    const context = docs.map((doc, index) => `[근거 ${index + 1}] ${doc.pageContent}\n출처: ${doc.metadata.document}\n부서: ${doc.metadata.department}\n업무 유형: ${doc.metadata.workType}`).join('\n\n');
    const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });
    const response = await model.invoke([
      ['system', [
        '당신은 사내 업무분장 안내 도우미입니다. 이 데모는 투자·공사, 재무·회계, 설비·자재 구매 관련 업무만 다룹니다. 제공된 근거만 사용하세요.',
        `owner와 partners는 반드시 다음 부서 목록 중에서만 선택하세요: ${allowedDepartments.join(', ')}. 목록에 없는 부서명은 절대 만들어내지 마세요.`,
        '질문이 투자·공사, 재무·회계, 설비·자재 구매와 무관하거나(예: 안전·인사 등), 근거에 목록 안의 부서가 명확히 나오지 않으면 owner를 빈 문자열로 두고 needsMoreInfo를 true로 하여 reason에 "투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다"라고 답하세요. 부서를 추측하지 마세요.',
        'partners(협업 부서)는 owner보다 기준을 넓게 적용하세요: 근거 문서 안에서 같은 업무·공정과 관련해 함께 등장하거나, owner의 상위/인접 조직이거나, 절차상 연결되는 부서가 있다면 위 목록 안에서 모두 partners에 포함하세요. owner와 동일한 부서는 partners에 절대 중복 포함하지 마세요. 정말로 관련 부서를 전혀 찾을 수 없을 때만 partners를 빈 배열로 두세요.',
        '여러 부서가 근거에 함께 등장하고 그중 일정 금액 기준(예: 5억원) 이상 여부를 심의·승인하는 절차(투자심의회 등)를 주관하는 부서가 있다면, 그 심의 주관 부서를 owner로 선택하고 나머지(구매 실행, 회계처리 등 후속 업무를 담당하는 부서)는 partners에 포함하세요. 심의 절차 없이 실행·처리 업무만 언급된 경우에는 그 실행 부서를 owner로 선택하세요.',
        '질문에 구체적인 금액이 명시되어 있고 근거 문서에 나온 심의 기준 금액에 미달하는 경우, 이는 범위 밖 질문이 아닙니다: 심의 주관 부서(예: 투자관리그룹)를 owner로 선택하지 말고, 대신 실행 부서(예: 설비자재구매그룹)를 owner로 선택한 뒤 needsMoreInfo는 false로, reason에는 기준 금액 미달로 내부 승인만으로 진행 가능하다는 취지를 적으세요. owner를 빈 문자열로 두거나 needsMoreInfo를 true로 하지 마세요.',
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
    // 온도 0이라도 LLM 호출은 완전히 결정적이지 않습니다. 근거(관련성 임계값을 통과한
    // primaryDocs)가 이미 확보돼 있는데도 LLM이 가끔 needsMoreInfo:true로 답하는 사례가
    // 확인되어(동일 질문을 반복하면 결과가 들쭉날쭉함), 서버가 이미 계산해 둔 부서별 관련성
    // 점수를 신뢰해 owner가 비어 있을 때는 결정적으로 채웁니다. LLM이 owner를 정상적으로
    // 찾은 경우는 그대로 두고 건드리지 않습니다.
    // 다만 이 폴백이 LLM의 정당한 판단까지 덮어써서는 안 됩니다(예: 질문 금액이 근거 문서의
    // 심의 기준 금액에 못 미쳐 "내부 승인 대상"이라고 구체적인 이유를 들어 owner를 비운 경우).
    // 그런 판단은 프롬프트 지시(reason에 구체적 근거를 적으라는 지시)를 따른 것이므로, reason이
    // 프롬프트가 제시한 범위-밖 정형 문구와 다르게 구체적으로 채워져 있으면 LLM의 판단을 존중해
    // 폴백을 건너뜁니다. reason이 비어 있거나 정형 문구 그대로인 경우만 "판단 실패(플레이키)"로
    // 간주해 기존처럼 관련성 점수로 자동 매칭합니다.
    const OUT_OF_SCOPE_BOILERPLATE = '투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다';
    const declinedWithSpecificReason = !ownerAllowed && result.needsMoreInfo === true
      && typeof result.reason === 'string' && result.reason.trim().length > 0
      && !result.reason.includes(OUT_OF_SCOPE_BOILERPLATE);
    const relevantPrimary = primaryRelevance
      .filter((entry) => entry.docs.length > 0)
      .sort((a, b) => b.score - a.score);
    let finalOwner = safeOwner;
    let finalPartners = safePartners;
    let finalNeedsMoreInfo = ownerAllowed ? result.needsMoreInfo : true;
    let finalReason = typeof result.reason === 'string' ? result.reason : '';
    if (!finalOwner && !declinedWithSpecificReason && relevantPrimary.length > 0) {
      finalOwner = relevantPrimary[0].department;
      finalNeedsMoreInfo = false;
      finalPartners = [...new Set([...safePartners, ...relevantPrimary.slice(1).map((entry) => entry.department)])].filter(
        (partner) => partner !== finalOwner
      );
      finalReason = '검색된 지침 근거에서 관련 부서가 확인되어 자동으로 매칭되었습니다.';
    }
    const safeResult = { ...result, owner: finalOwner, partners: finalPartners, needsMoreInfo: finalNeedsMoreInfo, reason: finalReason };
    return NextResponse.json({ ...safeResult, retrieved: docs.map((doc) => ({ content: doc.pageContent, ...doc.metadata })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RAG 검색 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
