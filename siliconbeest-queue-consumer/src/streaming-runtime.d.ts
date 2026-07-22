declare namespace Cloudflare {
  interface Env {
    STREAMING_DO?: DurableObjectNamespace<
      import('../../siliconbeest/server/worker/durableObjects/streaming').StreamingDO
    >;
    STREAM_FANOUT_DO?: DurableObjectNamespace<
      import('../../siliconbeest/server/worker/durableObjects/streamFanout').StreamFanoutDO
    >;
    REALTIME_FEED_DO?: DurableObjectNamespace<
      import('../../siliconbeest/server/worker/durableObjects/realtimeFeedIndex').RealtimeFeedIndexDO
    >;
    STREAM_PUBLIC_BRANCH_FACTOR?: string;
    STREAM_PUBLIC_TREE_DEPTH?: string;
    STREAM_PUBLIC_LEAF_MAX_SOCKETS?: string;
    STREAM_USER_MAX_SOCKETS?: string;
    STREAM_SOCKET_MAX_BUFFERED_BYTES?: string;
    STREAM_EVENT_MAX_BYTES?: string;
  }
}
