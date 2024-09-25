import {
  type Message,
  type InteractionCollector,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
} from "discord.js";
import { getLocalization } from "../localization/localization";

export interface PaginatorPage {
  embed: EmbedBuilder;
  components: ButtonBuilder[];
}

export type ButtonHandler = (
  interaction: ButtonInteraction,
  additionalParam?: string
) => Promise<void>;

export interface PaginatorOptions {
  interaction: ChatInputCommandInteraction;
  pages: PaginatorPage[];
  totalItems: number;
  initialPage?: number;
  timeout?: number;
  additionalButtonHandlers?: Map<
    string,
    { handler: ButtonHandler; param?: string }
  >;
}

export class Paginator {
  private interaction: ChatInputCommandInteraction;
  private pages: PaginatorPage[];
  private totalItems: number;
  private currentPage: number;
  private timeout: number;
  private message!: Message;
  private collector!: InteractionCollector<ButtonInteraction>;
  private additionalButtonHandlers: Map<
    string,
    { handler: ButtonHandler; param?: string }
  >;

  constructor(options: PaginatorOptions) {
    this.interaction = options.interaction;
    this.pages = options.pages;
    this.totalItems = options.totalItems;
    this.currentPage = options.initialPage ?? 0;
    this.timeout = options.timeout ?? 60000;
    this.additionalButtonHandlers =
      options.additionalButtonHandlers ?? new Map();
  }

  private totalPages(): number {
    return this.pages.length;
  }

  private createButtons(): ActionRowBuilder<ButtonBuilder> {
    const lang = this.interaction.locale || "en";
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`paginator-previous_${this.interaction.id}`)
        .setLabel(
          getLocalization("components.buttons.paginator.previous", lang)
        )
        .setStyle(ButtonStyle.Primary)
        .setDisabled(this.currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`paginator-next_${this.interaction.id}`)
        .setLabel(getLocalization("components.buttons.paginator.next", lang))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(this.currentPage >= this.totalPages() - 1)
    );
  }

  public getPageContent(): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const lang = this.interaction.locale || "en";
    const embed = this.pages[this.currentPage].embed;

    embed.setFooter({
      text: getLocalization("paginator.pageIndicator", lang, {
        currentPage: (this.currentPage + 1).toString(),
        totalPages: this.pages.length.toString(),
        totalItems: this.totalItems.toString(),
      }),
      iconURL: this.interaction.user.displayAvatarURL(),
    });

    const components: ActionRowBuilder<ButtonBuilder>[] = [
      this.createButtons(),
    ];
    if (this.pages[this.currentPage].components.length > 0) {
      const additionalRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.pages[this.currentPage].components
      );
      components.push(additionalRow);
    }

    return {
      embeds: [embed],
      components: components,
    };
  }

  public getCurrentPage(): number {
    return this.currentPage;
  }

  public async start(): Promise<void> {
    this.message = (await this.interaction.editReply(
      this.getPageContent()
    )) as Message;

    this.collector = this.message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: this.timeout,
    });

    this.collector.on("collect", this.handleInteraction.bind(this));
    this.collector.on("end", this.handleCollectorEnd.bind(this));
  }

  public async updateCurrentPageEmbed(newEmbed: EmbedBuilder): Promise<void> {
    this.pages[this.currentPage].embed = newEmbed;
    if (this.message) {
      await this.interaction.editReply(this.getPageContent());
    }
  }

  private async handleInteraction(i: ButtonInteraction): Promise<void> {
    const [action, id, ...params] = i.customId.split("_");

    if (action === "paginator-previous" && id === this.interaction.id) {
      this.currentPage = Math.max(0, this.currentPage - 1);
      await i.update(this.getPageContent());
    } else if (action === "paginator-next" && id === this.interaction.id) {
      this.currentPage = Math.min(this.totalPages() - 1, this.currentPage + 1);
      await i.update(this.getPageContent());
    } else {
      const handlerInfo = this.additionalButtonHandlers.get(action);
      if (handlerInfo) {
        await handlerInfo.handler(i, ...params);
        await i.update(this.getPageContent());
      }
    }

    this.refreshTimer();
  }

  private async handleCollectorEnd(): Promise<void> {
    if (this.message) {
      await this.interaction.editReply({ components: [] });
    }

    this.cleanup();
  }

  private refreshTimer(): void {
    this.collector.resetTimer();
  }

  public cleanup(): void {
    if (this.collector) {
      this.collector.stop();
    }
  }
}
