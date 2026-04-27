#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { iCloudMailClient } from './lib/icloud-mail-client.js';
import { iCloudConfig, IcloudMailError } from './types/config.js';

const server = new Server(
  {
    name: 'icloud-mail-mcp',
    version: '1.3.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let mailClient: iCloudMailClient | null = null;

async function initializeFromEnv() {
  if (process.env.ICLOUD_EMAIL && process.env.ICLOUD_APP_PASSWORD) {
    const config: iCloudConfig = {
      email: process.env.ICLOUD_EMAIL,
      appPassword: process.env.ICLOUD_APP_PASSWORD,
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
    };

    try {
      mailClient = new iCloudMailClient(config);
      await mailClient.connect();
      console.error(`Auto-configured iCloud Mail for ${config.email}`);
    } catch (error) {
      console.error('Failed to auto-configure iCloud Mail:', error);
      // Keep the client around — ensureConnected() will retry on next tool call
    }
  }
}

initializeFromEnv();

function requireClient(): iCloudMailClient {
  if (!mailClient) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'iCloud Mail not configured. Please set ICLOUD_EMAIL and ICLOUD_APP_PASSWORD environment variables.'
    );
  }
  return mailClient;
}

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function textContent(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_messages',
        description:
          'Get email messages from a mailbox. Returns IMAP UIDs as message ids (changed in v1.2.0).',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of messages to retrieve',
              default: 10,
            },
            unreadOnly: {
              type: 'boolean',
              description: 'Retrieve only unread messages',
              default: false,
            },
            metadataOnly: {
              type: 'boolean',
              description:
                'If true, fetch envelope and flags only (no body, no attachments). Much smaller responses.',
              default: false,
            },
            bodyPreview: {
              type: 'number',
              description:
                'When set, truncate body to this many characters and omit attachments.',
            },
          },
        },
      },
      {
        name: 'send_email',
        description: 'Send an email through iCloud Mail',
        inputSchema: {
          type: 'object',
          properties: {
            to: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'Recipient email address(es)',
            },
            subject: { type: 'string', description: 'Email subject' },
            text: { type: 'string', description: 'Plain text email body' },
            html: { type: 'string', description: 'HTML email body' },
          },
          required: ['to', 'subject'],
        },
      },
      {
        name: 'mark_as_read',
        description: 'Mark email messages as read by IMAP UID',
        inputSchema: {
          type: 'object',
          properties: {
            messageIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IMAP UIDs as strings (e.g. ["12345"]).',
            },
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
          },
          required: ['messageIds'],
        },
      },
      {
        name: 'get_mailboxes',
        description:
          'List all available mailboxes as a flat array (path/name/delimiter/flags/specialUse). Replaces the previous nested tree.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_mailbox_stats',
        description:
          'Return total/unread/recent counts for a mailbox. Use this to ground the agent on mailbox size before designing rules.',
        inputSchema: {
          type: 'object',
          properties: {
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
          },
        },
      },
      {
        name: 'test_connection',
        description: 'Test the email server connection (IMAP and SMTP)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'create_mailbox',
        description: 'Create a new mailbox (folder)',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the mailbox to create',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'delete_mailbox',
        description: 'Delete an existing mailbox (folder)',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the mailbox to delete',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'move_messages',
        description:
          'Move messages between mailboxes by IMAP UID. Idempotent: messages whose RFC822 Message-ID already exists in the destination are skipped, not duplicated. Returns count verification by default — compares source and destination totals before/after to surface drift.',
        inputSchema: {
          type: 'object',
          properties: {
            messageIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IMAP UIDs as strings (e.g. ["12345"]).',
            },
            sourceMailbox: {
              type: 'string',
              description: 'Source mailbox name',
            },
            destinationMailbox: {
              type: 'string',
              description: 'Destination mailbox name',
            },
            dryRun: {
              type: 'boolean',
              description:
                'If true, return previews of messages that would be moved without performing the move.',
              default: false,
            },
            verifyCounts: {
              type: 'boolean',
              description:
                'If true (default), capture source and destination counts before/after the move and surface a countWarning if the deltas disagree with the expected number of moves by more than 5 messages. Disable when chaining many moves to save round-trips.',
              default: true,
            },
          },
          required: ['messageIds', 'sourceMailbox', 'destinationMailbox'],
        },
      },
      {
        name: 'search_messages',
        description: 'Search for messages using various criteria',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query text (matches subject or body)',
            },
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of messages to retrieve',
              default: 10,
            },
            dateFrom: {
              type: 'string',
              description: 'Start date for search (YYYY-MM-DD)',
            },
            dateTo: {
              type: 'string',
              description: 'End date for search (YYYY-MM-DD)',
            },
            fromEmail: {
              type: 'string',
              description: 'Filter by sender email address',
            },
            unreadOnly: {
              type: 'boolean',
              description: 'Search only unread messages',
              default: false,
            },
            metadataOnly: {
              type: 'boolean',
              description:
                'If true, fetch envelope and flags only (no body, no attachments).',
              default: false,
            },
            bodyPreview: {
              type: 'number',
              description:
                'When set, truncate body to this many characters and omit attachments.',
            },
          },
        },
      },
      {
        name: 'delete_messages',
        description:
          'Delete messages by IMAP UID. Returns count verification by default — captures the source mailbox total before/after to surface drift.',
        inputSchema: {
          type: 'object',
          properties: {
            messageIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IMAP UIDs as strings.',
            },
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
            dryRun: {
              type: 'boolean',
              description:
                'If true, return previews of messages that would be deleted without performing the delete.',
              default: false,
            },
            verifyCounts: {
              type: 'boolean',
              description:
                'If true (default), capture mailbox total before/after the delete and surface a countWarning if the delta differs from the expected number of deletes by more than 5 messages.',
              default: true,
            },
          },
          required: ['messageIds'],
        },
      },
      {
        name: 'set_flags',
        description:
          'Set flags on messages by IMAP UID (read/unread, flagged, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            messageIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'IMAP UIDs as strings.',
            },
            flags: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Array of flags to set (e.g., ["\\\\Seen", "\\\\Flagged"])',
            },
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
            action: {
              type: 'string',
              enum: ['add', 'remove'],
              description: 'Whether to add or remove the flags (default: add)',
              default: 'add',
            },
          },
          required: ['messageIds', 'flags'],
        },
      },
      {
        name: 'download_attachment',
        description: 'Download an attachment from a specific message by UID',
        inputSchema: {
          type: 'object',
          properties: {
            messageId: {
              type: 'string',
              description: 'IMAP UID as string.',
            },
            attachmentIndex: {
              type: 'number',
              description: 'Index of the attachment to download (0-based)',
              default: 0,
            },
            mailbox: {
              type: 'string',
              description: 'Mailbox name (default: INBOX)',
              default: 'INBOX',
            },
          },
          required: ['messageId'],
        },
      },
      {
        name: 'auto_organize',
        description:
          'Automatically organize emails based on rules (sender, subject keywords). Considers up to maxMessages (default 100) most recent messages from sourceMailbox; for larger sets, use search_messages + move_messages with explicit UIDs. Inherits the idempotent move from move_messages. Each rule has a ruleStatus of "completed" | "pending" | "failed"; if the time budget is exhausted before all rules run, remaining rules are returned with ruleStatus: "pending" so callers can retry just those.',
        inputSchema: {
          type: 'object',
          properties: {
            rules: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Rule name' },
                  condition: {
                    type: 'object',
                    properties: {
                      fromContains: {
                        type: 'string',
                        description: 'Move emails if sender contains this text',
                      },
                      subjectContains: {
                        type: 'string',
                        description:
                          'Move emails if subject contains this text',
                      },
                    },
                  },
                  action: {
                    type: 'object',
                    properties: {
                      moveToMailbox: {
                        type: 'string',
                        description: 'Mailbox to move matching emails to',
                      },
                    },
                    required: ['moveToMailbox'],
                  },
                },
                required: ['name', 'condition', 'action'],
              },
              description: 'Array of organization rules',
            },
            sourceMailbox: {
              type: 'string',
              description: 'Source mailbox to organize (default: INBOX)',
              default: 'INBOX',
            },
            dryRun: {
              type: 'boolean',
              description:
                'If true, only show what would be organized without moving emails',
              default: false,
            },
            maxMessages: {
              type: 'number',
              description:
                'Maximum number of recent messages to consider from sourceMailbox (default: 100). Caps how much of the mailbox the rules scan in one call.',
              default: 100,
            },
            timeBudgetMs: {
              type: 'number',
              description:
                'Wall-clock budget in milliseconds for the whole call (default: 50000). When the budget is exhausted, remaining rules are returned with ruleStatus: "pending" instead of being silently dropped at the MCP timeout. Set lower for tighter loops, higher only if you control the MCP-client timeout.',
              default: 50000,
            },
          },
          required: ['rules'],
        },
      },
      {
        name: 'check_config',
        description:
          'Check whether environment variables are configured and probe the live IMAP connection.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_messages': {
        const client = requireClient();
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const limit = (args?.limit as number) || 10;
        const unreadOnly = (args?.unreadOnly as boolean) || false;
        const metadataOnly = args?.metadataOnly as boolean | undefined;
        const bodyPreview = args?.bodyPreview as number | undefined;
        const messages = await client.getMessages(mailbox, limit, unreadOnly, {
          metadataOnly,
          bodyPreview,
        });
        return jsonContent(messages);
      }

      case 'send_email': {
        const client = requireClient();
        const result = await client.sendEmail({
          to: args?.to as string | string[],
          subject: args?.subject as string,
          text: args?.text as string,
          html: args?.html as string,
        });
        return textContent(
          `Email sent successfully. Message ID: ${result.messageId}`
        );
      }

      case 'mark_as_read': {
        const client = requireClient();
        const messageIds = (args?.messageIds as string[]) ?? [];
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const result = await client.markAsRead(messageIds, mailbox);
        return jsonContent(result);
      }

      case 'get_mailboxes': {
        const client = requireClient();
        const mailboxes = await client.getMailboxes();
        return jsonContent(mailboxes);
      }

      case 'get_mailbox_stats': {
        const client = requireClient();
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const stats = await client.getMailboxStats(mailbox);
        return jsonContent(stats);
      }

      case 'test_connection': {
        const client = requireClient();
        const result = await client.testConnection();
        return jsonContent(result);
      }

      case 'create_mailbox': {
        const client = requireClient();
        const mailboxName = args?.name as string;
        if (!mailboxName) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Mailbox name is required'
          );
        }
        const result = await client.createMailbox(mailboxName);
        return jsonContent(result);
      }

      case 'delete_mailbox': {
        const client = requireClient();
        const mailboxName = args?.name as string;
        if (!mailboxName) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Mailbox name is required'
          );
        }
        const result = await client.deleteMailbox(mailboxName);
        return jsonContent(result);
      }

      case 'move_messages': {
        const client = requireClient();
        const messageIds = (args?.messageIds as string[]) ?? [];
        const sourceMailbox = args?.sourceMailbox as string;
        const destinationMailbox = args?.destinationMailbox as string;
        const dryRun = (args?.dryRun as boolean) || false;
        const verifyCounts =
          args?.verifyCounts === undefined
            ? undefined
            : (args.verifyCounts as boolean);
        const result = await client.moveMessages(
          messageIds,
          sourceMailbox,
          destinationMailbox,
          { dryRun, verifyCounts }
        );
        return jsonContent(result);
      }

      case 'search_messages': {
        const client = requireClient();
        const messages = await client.searchMessages({
          query: args?.query as string,
          mailbox: (args?.mailbox as string) || 'INBOX',
          limit: (args?.limit as number) || 10,
          dateFrom: args?.dateFrom as string,
          dateTo: args?.dateTo as string,
          fromEmail: args?.fromEmail as string,
          unreadOnly: (args?.unreadOnly as boolean) || false,
          metadataOnly: args?.metadataOnly as boolean | undefined,
          bodyPreview: args?.bodyPreview as number | undefined,
        });
        return jsonContent(messages);
      }

      case 'delete_messages': {
        const client = requireClient();
        const messageIds = (args?.messageIds as string[]) ?? [];
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const dryRun = (args?.dryRun as boolean) || false;
        const verifyCounts =
          args?.verifyCounts === undefined
            ? undefined
            : (args.verifyCounts as boolean);
        const result = await client.deleteMessages(messageIds, mailbox, {
          dryRun,
          verifyCounts,
        });
        return jsonContent(result);
      }

      case 'set_flags': {
        const client = requireClient();
        const messageIds = (args?.messageIds as string[]) ?? [];
        const flags = (args?.flags as string[]) ?? [];
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const action = (args?.action as string) || 'add';
        const result = await client.setFlags(
          messageIds,
          flags,
          mailbox,
          action as 'add' | 'remove'
        );
        return jsonContent(result);
      }

      case 'download_attachment': {
        const client = requireClient();
        const messageId = args?.messageId as string;
        const attachmentIndex = (args?.attachmentIndex as number) || 0;
        const mailbox = (args?.mailbox as string) || 'INBOX';
        const result = await client.downloadAttachment(
          messageId,
          attachmentIndex,
          mailbox
        );
        return jsonContent(result);
      }

      case 'auto_organize': {
        const client = requireClient();
        const rules = args?.rules as Array<{
          name: string;
          condition: { fromContains?: string; subjectContains?: string };
          action: { moveToMailbox: string };
        }>;
        const sourceMailbox = (args?.sourceMailbox as string) || 'INBOX';
        const dryRun = (args?.dryRun as boolean) || false;
        const maxMessages = (args?.maxMessages as number) || 100;
        const timeBudgetMs = (args?.timeBudgetMs as number) || 50000;
        const result = await client.autoOrganize(
          rules,
          sourceMailbox,
          dryRun,
          maxMessages,
          timeBudgetMs
        );
        return jsonContent(result);
      }

      case 'check_config': {
        const maskCredential = (value: string | undefined) => {
          if (!value) return 'Not set';
          if (value.length <= 4) return '***';
          return value.substring(0, 4) + '***';
        };

        let connectionStatus: 'connected' | 'disconnected' | 'unconfigured' =
          'unconfigured';
        let probeError: string | undefined;
        if (mailClient) {
          try {
            await mailClient.ensureConnected();
            connectionStatus = 'connected';
          } catch (err) {
            connectionStatus = 'disconnected';
            probeError = err instanceof Error ? err.message : String(err);
          }
        }

        return jsonContent({
          email: {
            value: maskCredential(process.env.ICLOUD_EMAIL),
            configured: !!process.env.ICLOUD_EMAIL,
          },
          appPassword: {
            value: maskCredential(process.env.ICLOUD_APP_PASSWORD),
            configured: !!process.env.ICLOUD_APP_PASSWORD,
          },
          connectionStatus,
          probeError,
        });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof IcloudMailError) {
      // Surface structured info as a JSON tool response so callers can act on it.
      return jsonContent({
        status: 'error',
        error: error.toJSON(),
      });
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing tool ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('iCloud Mail MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
