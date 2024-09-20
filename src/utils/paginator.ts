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

export class Paginator {
  private interaction: ChatInputCommandInteraction;
  private pages: PaginatorPage[];
  private totalItems: number;
  private currentPage: number;
  private timeout: number;
  private message: Message | null;
  private collector!: InteractionCollector<ButtonInteraction>;

  constructor(
    interaction: ChatInputCommandInteraction,
    pages: PaginatorPage[],
    totalItems: number,
    timeout: number = 60000
  ) {
    this.interaction = interaction;
    this.pages = pages;
    this.totalItems = totalItems;
    this.currentPage = 0;
    this.timeout = timeout;
    this.message = null;
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

    const components = this.pages[this.currentPage].components;

    const newRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      this.createButtons().components[0],
      this.createButtons().components[1],
      ...components
    );

    return {
      embeds: [embed],
      components: [newRow],
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

  private async handleInteraction(i: ButtonInteraction): Promise<void> {
    if (i.customId === `paginator-previous_${this.interaction.id}`) {
      this.currentPage = Math.max(0, this.currentPage - 1);
    } else if (i.customId === `paginator-next_${this.interaction.id}`) {
      this.currentPage = Math.min(this.totalPages() - 1, this.currentPage + 1);
    }

    this.refreshTimer();

    await i.update(this.getPageContent());
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
