# Cloudflare Workers `waitUntil`과 Fedify 큐 래퍼

## 문제: Workers의 Promise 수명

Cloudflare Workers는 `Response`를 반환하면 해당 요청의 실행 컨텍스트가 종료됩니다. 이때 **await하지 않은 Promise는 즉시 kill**됩니다:

```typescript
export default {
  async fetch(request) {
    // 이 Promise는 await하지 않으므로 fire-and-forget
    someQueue.send({ type: 'deliver', data: '...' }); // 유실 가능!

    return new Response('OK'); // 응답 반환 -> Worker 종료 -> 위 Promise kill
  }
};
```

`Queue.send()`는 네트워크 I/O이므로 수 밀리초가 걸립니다. `Response` 반환이 먼저 완료되면 `send()`가 실제로 Cloudflare Queue에 도달하기 전에 Worker가 종료됩니다.

## `ctx.waitUntil()`의 역할

```typescript
export default {
  async fetch(request, env, ctx) {
    const promise = someQueue.send({ type: 'deliver', data: '...' });
    ctx.waitUntil(promise); // Worker야, 이 Promise 끝날 때까지 살아있어

    return new Response('OK'); // 응답은 즉시 반환, Worker는 promise 완료까지 유지
  }
};
```

`ctx.waitUntil(promise)`에 등록하면:

1. 클라이언트에게 응답은 즉시 반환
2. Worker 프로세스는 등록된 모든 Promise가 settle될 때까지 유지
3. `Queue.send()`가 실제로 완료된 후에야 Worker 종료

## Fedify의 문제

Fedify의 `sendActivity()`는 내부적으로 fan-out 패턴을 사용합니다:

```
사용자가 게시글 작성
  -> Fedify.sendActivity() 호출
    -> 팔로워 목록 조회
    -> 각 팔로워의 inbox로 Activity 전달을 위해 queue.enqueue() 호출
    -> 이때 enqueue()를 await하지 않음 (fire-and-forget fan-out)
```

Fedify는 Node.js/Deno 환경을 기본으로 설계되어, 프로세스가 계속 살아있는 걸 전제합니다. Cloudflare Workers에서는 응답 후 프로세스가 죽으므로 fan-out enqueue가 유실됩니다.

## CloudflareMessageQueue 래퍼

`packages/shared/fedify/cloudflare-queue.ts`에 정의된 래퍼 클래스입니다.

```typescript
export class CloudflareMessageQueue implements MessageQueueLike {
  private inner: InnerQueue;              // WorkersMessageQueue
  waitUntilFn: ((p: Promise<unknown>) => void) | null;

  enqueue(message, options) {
    const promise = this.inner.enqueue(message, options);

    // 핵심: 매 enqueue Promise를 waitUntil에 등록
    if (this.waitUntilFn) {
      this.waitUntilFn(promise);
    }

    return promise;
  }

  // listen()은 no-op
  // Cloudflare Workers에서 WorkersMessageQueue.listen()은 TypeError를 throw합니다.
  // Fedify가 내부적으로 listen()을 호출할 수 있으므로 no-op으로 흡수합니다.
  async listen() {}
}
```

### 두 가지 역할

1. **`waitUntil` 래핑** — 매 `enqueue()` 호출 시 Promise를 `ctx.waitUntil()`에 등록하여 Worker 종료 전에 큐 전송이 완료되도록 보장
2. **`listen()` no-op** — `WorkersMessageQueue.listen()`은 `TypeError`를 throw하지만, Fedify가 내부적으로 호출할 수 있으므로 조용히 무시

## 요청 흐름

```
1. 요청 도착
   -> index.ts의 Hono 미들웨어에서:
     setWaitUntil((p) => c.executionCtx.waitUntil(p))
     // 매 요청마다 waitUntil 함수를 래퍼에 등록

2. 사용자가 게시글 작성
   -> createStatus()
     -> Fedify.sendActivity()
       -> CloudflareMessageQueue.enqueue(activity)
         -> WorkersMessageQueue.enqueue(activity)  // 실제 Queue.send()
         -> waitUntilFn(promise)                    // ctx.waitUntil()에 등록

3. Response 반환 (즉시)
   -> 클라이언트는 "게시 완료" 응답 수신

4. Worker는 아직 살아있음
   -> Queue.send() Promise가 완료될 때까지 대기
   -> 모든 fan-out enqueue가 완료된 후 Worker 종료
```

## 래퍼 없이 WorkersMessageQueue만 쓰면?

- **팔로워 1명**: enqueue 1번 -> 대부분 응답 전에 완료 -> 유실 가능성 낮음
- **팔로워 100명**: enqueue 100번 fire-and-forget -> 응답이 먼저 반환 -> 대부분 유실
- **결과**: 게시글은 작성되지만 팔로워에게 전달 안 됨 (연합 실패)

## 관련 코드 위치

| 파일 | 역할 |
|------|------|
| `packages/shared/fedify/cloudflare-queue.ts` | `CloudflareMessageQueue` 래퍼 클래스 |
| `server/worker/federation/fedify.ts` | 래퍼로 감싼 queue를 Fedify에 전달 |
| `server/worker/index.ts` | 매 요청마다 `setWaitUntil()` 호출 |

## @fedify/cfworkers 타입 불일치

`@fedify/cfworkers`의 `WorkersKvStore`와 `WorkersMessageQueue`는 내부적으로 `@cloudflare/workers-types/experimental`의 `KVNamespace`와 `Queue` 타입을 사용합니다. wrangler가 생성한 글로벌 타입은 standard `KVNamespace`/`Queue`이며, experimental 버전에는 `deleteBulk` (KV), `metrics` (Queue) 등 추가 메서드가 있어 타입이 호환되지 않습니다.

**런타임에서는 정상 작동합니다.** 타입 불일치는 순수 컴파일 타임 이슈이므로 `@ts-expect-error` 주석으로 처리합니다:

```typescript
// @ts-expect-error -- @fedify/cfworkers uses @cloudflare/workers-types/experimental internally
cachedQueue = new CloudflareMessageQueue(new WorkersMessageQueue(env.QUEUE_FEDERATION));

cachedFed = createFederation<FedifyContextData>({
  // @ts-expect-error -- same wrangler vs experimental type mismatch
  kv: new WorkersKvStore(env.FEDIFY_KV),
});
```
