from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer


class StructuralEncoder(nn.Module):
    def __init__(self, in_dim: int = 15, hidden_dim: int = 128, out_dim: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(hidden_dim, out_dim),
            nn.GELU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class CodeSemanticEmbedder(nn.Module):
    def __init__(
        self,
        backbone_name: str = "microsoft/codebert-base",
        struct_dim: int = 15,
        proj_dim: int = 256,
    ):
        super().__init__()
        self.tokenizer = AutoTokenizer.from_pretrained(backbone_name)
        self.backbone = AutoModel.from_pretrained(backbone_name)
        hidden = self.backbone.config.hidden_size

        self.structural = StructuralEncoder(struct_dim, 128, 128)
        self.fusion = nn.Sequential(
            nn.Linear(hidden + 128, 512),
            nn.GELU(),
            nn.Dropout(0.1),
            nn.Linear(512, proj_dim),
        )

    def encode_text(self, input_ids, attention_mask, struct_feats):
        out = self.backbone(input_ids=input_ids, attention_mask=attention_mask)
        cls = out.last_hidden_state[:, 0, :]
        struct = self.structural(struct_feats)
        merged = torch.cat([cls, struct], dim=-1)
        emb = self.fusion(merged)
        return F.normalize(emb, p=2, dim=-1)

    def forward(self, input_ids, attention_mask, struct_feats):
        return self.encode_text(input_ids, attention_mask, struct_feats)
