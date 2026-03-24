import { extract } from "@extractus/article-extractor";
import { PDFParse } from "pdf-parse";

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

export class PdfContentExtractor implements ContentExtractor {
  async extract(url: string): Promise<ExtractedContent | null> {
    try {
      const parser = new PDFParse({ url });
      
      // Get both text content and metadata
      const [textResult, infoResult] = await Promise.all([
        parser.getText(),
        parser.getInfo()
      ]);
      
      await parser.destroy();

      if (!textResult || !textResult.text) {
        return null;
      }

      const info = infoResult?.info ?? {};
      const pageCount = textResult.pages?.length ?? info.Pages ?? null;

      // Extract PDF metadata
      const title = info.Title ?? null;
      const author = info.Author ?? null;
      const subject = info.Subject ?? null;
      const creator = info.Creator ?? null;
      const producer = info.Producer ?? null;
      const creationDate = info.CreationDate ?? null;
      const modificationDate = info.ModDate ?? null;

      return {
        url,
        title,
        content: textResult.text,
        imageUrl: null, // PDFs don't have a thumbnail by default
        metadata: {
          source: "pdf-parse",
          contentType: "pdf",
          pageCount,
          author,
          subject,
          creator,
          producer,
          creationDate,
          modificationDate,
          pdfVersion: info.PDFFormatVersion ?? null
        }
      };
    } catch (error) {
      // Return null on any extraction failure
      return null;
    }
  }
}
