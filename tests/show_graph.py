from app.graph import graph

png = graph.get_graph().draw_mermaid_png()
with open("graph.png", "wb") as f:
    f.write(png)

print("Saved graph.png")
print(graph.get_graph().draw_mermaid())  # text version, paste into mermaid.live if needed

