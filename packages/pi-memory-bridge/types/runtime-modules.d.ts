declare module "@sinclair/typebox" {
  export type TSchema = any;
  export type Static<T = any> = any;
  export const Type: {
    Object: (...args: any[]) => any;
    String: (...args: any[]) => any;
    Number: (...args: any[]) => any;
    Boolean: (...args: any[]) => any;
    Array: (...args: any[]) => any;
    Optional: (...args: any[]) => any;
    Union: (...args: any[]) => any;
    Literal: (...args: any[]) => any;
    Record: (...args: any[]) => any;
  };
}

declare module "@mariozechner/pi-ai" {
  export type Api = any;
  export type AssistantMessageEvent = any;
  export type AssistantMessageEventStream = any;
  export type Context = any;
  export type ImageContent = any;
  export type Message = any;
  export type Model<T = any> = any;
  export type OAuthCredentials = any;
  export type OAuthLoginCallbacks = any;
  export type SimpleStreamOptions = any;
  export type TextContent = any;
  export type ToolResultMessage = any;
  export const StringEnum: any;
}
