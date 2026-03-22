import { extract } from "@extractus/article-extractor";

export interface ExtractedContent {
  url: string;
  title: string | null;
  content: string | null;
  imageUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface ContentExtractor {
  extract(url: string): Promise<ExtractedContent | null>;
}

export class ArticleExtractorContentExtractor implements ContentExtractor {
  async extract(url: string): Promise<ExtractedContent | null> {
    const article = await extract(url);
    if (!article) {
      return null;
    }

    const image = article.image ?? null;

    return {
      url,
      title: article.title ?? null,
      content: article.content ?? article.description ?? null,
      imageUrl: image,
      metadata: {
        source: "article-extractor",
        published: article.published ?? null,
        author: article.author ?? null,
        description: article.description ?? null
      }
    };
  }
}
