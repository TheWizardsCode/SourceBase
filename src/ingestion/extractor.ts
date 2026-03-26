import { extract } from "@extractus/article-extractor";
import { htmlToText } from "html-to-text";
import { PDFParse } from "pdf-parse";
import { promises as fs } from "fs";
import { extname } from "path";

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
    const rawHtml = article.content ?? null;

    if (!rawHtml) {
      return null;
    }

    const plainText = await htmlToText(rawHtml, {
      selectors: [
        { selector: "nav", format: "skip" },
        { selector: "header", format: "skip" },
        { selector: "footer", format: "skip" },
        { selector: "aside", format: "skip" },
        { selector: ".sidebar", format: "skip" },
        { selector: ".advertisement", format: "skip" },
        { selector: ".ad", format: "skip" },
        { selector: ".related", format: "skip" },
        { selector: ".comments", format: "skip" },
        { selector: "img", format: "skip" },
        {
          selector: "a",
          options: {
            ignoreHref: true,
            hideLinkHrefIfSameAsText: true
          }
        }
      ]
    });

    const content = plainText.trim() || null;

    if (!content) {
      return null;
    }

    return {
      url,
      title: article.title ?? null,
      content,
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

export class FileContentExtractor implements ContentExtractor {
  private pdfExtractor: PdfContentExtractor;

  constructor() {
    this.pdfExtractor = new PdfContentExtractor();
  }

  private getFilePathFromUrl(url: string): string {
    const parsed = new URL(url);
    // file:// URLs have pathname starting with / on all platforms
    // On Windows: file:///C:/path/to/file -> pathname is /C:/path/to/file
    // On Unix: file:///home/user/file -> pathname is /home/user/file
    return decodeURIComponent(parsed.pathname);
  }

  private async checkForSymlink(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(filePath);
      return stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private isTextFile(filePath: string): boolean {
    const textExtensions = ['.txt', '.md', '.html', '.htm', '.json', '.js', '.ts', '.css', '.xml', '.csv', '.yaml', '.yml'];
    const ext = extname(filePath).toLowerCase();
    return textExtensions.includes(ext);
  }

  private async readTextFile(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch {
      return null;
    }
  }

  async extract(url: string): Promise<ExtractedContent | null> {
    try {
      const filePath = this.getFilePathFromUrl(url);

      // Check for symbolic links and reject them
      const isSymlink = await this.checkForSymlink(filePath);
      if (isSymlink) {
        throw new Error("Symbolic links are not supported");
      }

      // Check if file exists and is readable
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error("Failed to process file");
      }

      // For PDF files, use the existing PDF extractor
      if (filePath.toLowerCase().endsWith('.pdf')) {
        return this.pdfExtractor.extract(url);
      }

      // For text-based files, read directly
      if (this.isTextFile(filePath)) {
        const content = await this.readTextFile(filePath);
        if (content === null) {
          throw new Error("Failed to process file");
        }

        // Try to extract title from HTML files
        let title: string | null = null;
        const ext = extname(filePath).toLowerCase();
        if (ext === '.html' || ext === '.htm') {
          const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
          title = titleMatch?.[1]?.trim() || null;
        }

        return {
          url,
          title: title || filePath.split('/').pop() || null,
          content,
          imageUrl: null,
          metadata: {
            source: "file",
            contentType: ext.replace('.', '') || 'text',
            fileSize: stats.size,
            modifiedTime: stats.mtime.toISOString()
          }
        };
      }

      // For unsupported file types, return null
      throw new Error("Failed to process file");
    } catch (error) {
      if (error instanceof Error && error.message === "Symbolic links are not supported") {
        throw error;
      }
      throw new Error("Failed to process file");
    }
  }
}
